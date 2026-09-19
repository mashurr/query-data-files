import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineError, EngineReply } from './shared/protocol';

// The engine is restarted after a crash at most this many times in a row
const MAX_RESTARTS = 3;
// A crash-free run this long resets the restart count
const STABLE_MS = 60_000;
// DuckDB may use this share of the machine's memory before spilling to disk
const MEMORY_SHARE = 0.5;

interface Pending {
    resolve(reply: EngineReply): void;
}

/** Views re-open their files through this after the engine restarts */
export interface EngineClient {
    reopen(): void;
}

/**
 * Runs `qdf-engine serve` and talks to it over stdin/stdout. Every request names a
 * session (one DuckDB connection in the engine); requests in one session run in order.
 */
export class Engine implements vscode.Disposable {
    private child: cp.ChildProcess | undefined;
    private starting: Promise<void> | undefined;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private buffer: Buffer = Buffer.alloc(0);
    private restarts = 0;
    private startedAt = 0;
    private stopping = false;
    private readonly allowedPaths = new Set<string>();
    private readonly clients = new Set<EngineClient>();
    private info: { version: string; extensions: Record<string, boolean> } | undefined;
    private readonly output: vscode.OutputChannel;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel('Query Data Files');
    }

    get version(): string | undefined { return this.info?.version; }

    hasExtension(name: 'sqlite_scanner' | 'excel'): boolean { return this.info?.extensions[name] ?? false; }

    register(client: EngineClient): vscode.Disposable {
        this.clients.add(client);
        return new vscode.Disposable(() => this.clients.delete(client));
    }

    /** Folders DuckDB may read: the workspace, the extension's own files and its scratch folder */
    private allowedDirectories(): string[] {
        const dirs = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
        dirs.push(this.scratchDir(), this.context.extensionPath);
        return dirs.map(d => d.endsWith(path.sep) ? d : d + path.sep);
    }

    scratchDir(): string {
        const dir = path.join(this.context.globalStorageUri.fsPath, 'scratch');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Lets DuckDB read a file outside the workspace; the engine restarts to widen its allow-list */
    async allow(file: string): Promise<void> {
        const inside = this.allowedDirectories().some(dir => file.startsWith(dir));
        if (inside || this.allowedPaths.has(file)) { return; }
        this.allowedPaths.add(file);
        if (this.child) {
            await this.restart(false);
        }
    }

    async request(method: string, params: object = {}, session = 'default'): Promise<EngineReply> {
        await this.ensureStarted();
        return this.send(method, params, session);
    }

    private send(method: string, params: object, session: string): Promise<EngineReply> {
        const child = this.child;
        if (!child?.stdin?.writable) {
            return Promise.resolve(failure('crashed', 'The query engine isn\'t running.'));
        }
        const id = this.nextId++;
        const header = Buffer.from(JSON.stringify({ id, method, session, params }), 'utf8');
        const lengths = Buffer.alloc(8);
        lengths.writeUInt32LE(header.length, 0);
        lengths.writeUInt32LE(0, 4);
        return new Promise(resolve => {
            this.pending.set(id, { resolve });
            child.stdin!.write(Buffer.concat([lengths, header]));
        });
    }

    private ensureStarted(): Promise<void> {
        if (this.child && !this.starting) { return Promise.resolve(); }
        this.starting ??= this.start().finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private executable(): string {
        const name = process.platform === 'win32' ? 'qdf-engine.exe' : 'qdf-engine';
        return path.join(this.context.extensionPath, 'bin', name);
    }

    private async start(): Promise<void> {
        const exe = this.executable();
        if (!fs.existsSync(exe)) {
            throw new Error(`The query engine is missing from this installation (${exe}). Reinstall the extension for your platform.`);
        }
        const cwd = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir();
        const child = cp.spawn(exe, ['serve'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        this.buffer = Buffer.alloc(0);
        this.startedAt = Date.now();
        child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
        child.stderr!.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
        child.on('error', err => this.output.appendLine(`Engine error: ${err.message}`));
        child.on('exit', (code, signal) => this.exited(child, code, signal));

        const reply = await this.send('init', {
            extensionDir: path.join(this.context.extensionPath, 'extensions'),
            tempDir: this.scratchDir(),
            allowedDirectories: this.allowedDirectories(),
            allowedPaths: [...this.allowedPaths],
            memoryLimit: `${Math.floor(os.totalmem() * MEMORY_SHARE / 1048576)}MB`,
        }, 'default');
        if (!reply.ok) {
            this.stopping = true;
            child.kill();
            this.child = undefined;
            this.stopping = false;
            throw new Error(`The query engine couldn't start: ${reply.error.message}`);
        }
        this.info = reply.result as { version: string; extensions: Record<string, boolean> };
        this.output.appendLine(`DuckDB ${this.info.version} ready`);
    }

    private receive(chunk: Buffer) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length >= 8) {
            const headerLength = this.buffer.readUInt32LE(0);
            const bodyLength = this.buffer.readUInt32LE(4);
            const end = 8 + headerLength + bodyLength;
            if (this.buffer.length < end) { break; }
            const header = JSON.parse(this.buffer.subarray(8, 8 + headerLength).toString('utf8'));
            const body = new Uint8Array(this.buffer.subarray(8 + headerLength, end));
            this.buffer = this.buffer.subarray(end);
            const pending = this.pending.get(header.id);
            if (pending) {
                this.pending.delete(header.id);
                pending.resolve(header.ok
                    ? { ok: true, result: header.result, body }
                    : { ok: false, error: header.error as EngineError });
            }
        }
    }

    private exited(child: cp.ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
        if (child !== this.child) { return; }
        this.child = undefined;
        for (const p of this.pending.values()) {
            p.resolve(failure('crashed', 'The query engine stopped while running this query. It restarts on the next query.'));
        }
        this.pending.clear();
        if (this.stopping) { return; }
        this.output.appendLine(`Engine exited (${signal ?? `code ${code}`})`);
        if (Date.now() - this.startedAt > STABLE_MS) { this.restarts = 0; }
        if (this.restarts >= MAX_RESTARTS) {
            vscode.window.showErrorMessage('The Query Data Files engine keeps stopping. See the "Query Data Files" output for details.', 'Show Output')
                .then(choice => { if (choice) { this.output.show(); } });
            return;
        }
        this.restarts++;
        this.ensureStarted().then(() => this.reopenAll(), err => this.output.appendLine(String(err)));
    }

    /** Stops the engine and starts a fresh one; open views load their files again */
    async restart(manual = true): Promise<void> {
        if (manual) { this.restarts = 0; }
        const child = this.child;
        if (child) {
            this.stopping = true;
            const gone = new Promise(resolve => child.once('exit', resolve));
            child.kill();
            await gone;
            this.stopping = false;
        }
        await this.ensureStarted();
        this.reopenAll();
    }

    private reopenAll() {
        for (const client of this.clients) { client.reopen(); }
    }

    dispose() {
        this.stopping = true;
        this.child?.kill();
        this.output.dispose();
    }
}

function failure(kind: EngineError['kind'], message: string): EngineReply {
    return { ok: false, error: { kind, message } };
}
