import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Engine, EngineClient } from './engine';
import { formatOf } from './formats';
import { HostMessage, Lane, OpenedFile, ViewInit, ViewMessage } from './shared/protocol';

// Changes on disk are picked up once the file has been quiet this long
const DISK_CHANGE_MS = 500;

const EXPORT_FILTERS: Record<string, Record<string, string[]>> = {
    csv: { 'CSV': ['csv'] },
    parquet: { 'Parquet': ['parquet'] },
    json: { 'JSON': ['json'] },
    xlsx: { 'Excel workbook': ['xlsx'] },
};

let nextViewId = 1;

export type ViewSource =
    | { kind: 'file'; uri: vscode.Uri }
    | { kind: 'sql'; title: string; sql: string; folder?: vscode.Uri };

/** One table view in a webview: a data file opened as `this`, or the results of a .sql file */
export class DataView implements EngineClient, vscode.Disposable {
    readonly id = `v${nextViewId++}`;
    private file: OpenedFile | undefined;
    private problem: string | undefined;
    private ready = false;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly lanesUsed = new Set<Lane>(['main']);
    private readonly resultNames = new Set<string>();
    private changeTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly engine: Engine,
        private readonly webview: vscode.Webview,
        private source: ViewSource,
    ) {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out'), vscode.Uri.joinPath(context.extensionUri, 'media')],
        };
        webview.html = this.html();
        this.disposables.push(
            webview.onDidReceiveMessage((m: ViewMessage) => this.receive(m)),
            engine.register(this),
        );
        if (source.kind === 'file') {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(source.uri.fsPath)), path.basename(source.uri.fsPath)));
            const changed = () => {
                clearTimeout(this.changeTimer);
                this.changeTimer = setTimeout(() => this.reopen(), DISK_CHANGE_MS);
            };
            this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
        }
    }

    /** Shows new SQL, e.g. when a .sql file runs again into the same results view */
    run(sql: string, title: string) {
        if (this.source.kind === 'sql') {
            this.source = { ...this.source, sql, title };
        }
        this.post({ type: 'run', sql });
    }

    /** Result tables are shared by every view in the engine, so names carry the view's id */
    private resultName(name: unknown): string {
        return `${this.id}_${typeof name === 'string' ? name : 'result'}`;
    }

    private session(lane: Lane): string {
        return lane === 'main' ? this.id : `${this.id}:${lane}`;
    }

    private post(message: HostMessage) {
        if (!this.disposed) { void this.webview.postMessage(message); }
    }

    private async receive(m: ViewMessage) {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                await this.sendInit();
                break;
            case 'engine': {
                this.lanesUsed.add(m.lane);
                const params = { ...m.params };
                if (m.method === 'query' || m.method === 'page' || m.method === 'export') {
                    const name = this.resultName(params.name);
                    params.name = name;
                    if (m.method === 'query') { this.resultNames.add(name); }
                }
                const reply = await this.engine.request(m.method, params, this.session(m.lane)).catch(err => ({
                    ok: false as const, error: { kind: 'crashed' as const, message: String(err instanceof Error ? err.message : err) },
                }));
                this.post({ type: 'reply', rid: m.rid, reply });
                break;
            }
            case 'cancel':
                await Promise.all(m.lanes.map(lane => this.engine.request('cancel', {}, this.session(lane)).catch(() => undefined)));
                break;
            case 'openTable':
                if (this.source.kind === 'file') {
                    await this.openFile(m.table, m.sheet);
                    this.post({ type: 'opened', file: this.file, problem: this.problem });
                }
                break;
            case 'export':
                await this.export(m.format, m.name, m.rows);
                break;
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                vscode.window.setStatusBarMessage(`Copied ${m.what}`, 3000);
                break;
            case 'error':
                vscode.window.showErrorMessage(m.message);
                break;
        }
    }

    private async sendInit() {
        let init: ViewInit;
        if (this.source.kind === 'file') {
            await this.openFile();
            init = {
                type: 'init', kind: 'file', title: path.basename(this.source.uri.fsPath),
                file: this.file, sql: 'SELECT * FROM this', problem: this.problem,
            };
        } else {
            init = { type: 'init', kind: 'sql', title: this.source.title, sql: this.source.sql };
        }
        this.post(init);
    }

    private async openFile(table?: string, sheet?: string) {
        if (this.source.kind !== 'file') { return; }
        const file = this.source.uri.fsPath;
        this.problem = undefined;
        const format = formatOf(file);
        if (!format) {
            this.problem = 'This file isn\'t a SQLite or DuckDB database, so it can\'t be opened as a table.';
            this.file = undefined;
            return;
        }
        if (!fs.existsSync(file)) {
            this.problem = 'This file no longer exists.';
            this.file = undefined;
            return;
        }
        await this.engine.allow(file).catch(() => undefined);
        const reply = await this.engine.request('open', { path: file, format, table, sheet }, this.session('main'))
            .catch(err => ({ ok: false as const, error: { kind: 'crashed' as const, message: String(err instanceof Error ? err.message : err) } }));
        if (!reply.ok) {
            this.problem = reply.error.message;
            this.file = { name: path.basename(file), path: file, format, source: null };
            return;
        }
        const r = reply.result as Partial<OpenedFile>;
        this.file = {
            name: path.basename(file), path: file, format, source: (r.source as string | null) ?? null,
            tables: r.tables, table: r.table, sheets: r.sheets, sheet: r.sheet, alias: r.alias,
        };
    }

    /** After an engine restart or a change on disk: open the file again and re-run the query */
    reopen() {
        if (!this.ready || this.disposed) { return; }
        void (async () => {
            if (this.source.kind === 'file') {
                await this.openFile(this.file?.table, this.file?.sheet);
                this.post({ type: 'opened', file: this.file, problem: this.problem });
            }
            this.post({ type: 'reset' });
        })();
    }

    private async export(format: 'csv' | 'parquet' | 'json' | 'xlsx', name: string, rows: number) {
        const base = this.source.kind === 'file'
            ? path.basename(this.source.uri.fsPath, path.extname(this.source.uri.fsPath)) + '-result'
            : 'query-result';
        const folder = this.source.kind === 'file' ? vscode.Uri.file(path.dirname(this.source.uri.fsPath))
            : this.source.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder, `${base}.${format}`) : undefined,
            filters: EXPORT_FILTERS[format],
            saveLabel: 'Export',
        });
        if (!target) { return; }
        const scratch = path.join(this.engine.scratchDir(), `${crypto.randomUUID()}.${format}`);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${rows.toLocaleString()} rows…` }, async () => {
            const reply = await this.engine.request('export', { name: this.resultName(name), format, path: scratch }, this.session('page'));
            if (!reply.ok) {
                vscode.window.showErrorMessage(`Export failed: ${reply.error.message}`);
                return;
            }
            try {
                await vscode.workspace.fs.copy(vscode.Uri.file(scratch), target, { overwrite: true });
                vscode.window.setStatusBarMessage(`Exported ${rows.toLocaleString()} rows to ${path.basename(target.fsPath)}`, 5000);
            } catch (err) {
                vscode.window.showErrorMessage(`Couldn't write ${target.fsPath}: ${err instanceof Error ? err.message : err}`);
            } finally {
                fs.rm(scratch, { force: true }, () => undefined);
            }
        });
    }

    private html(): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const script = this.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'data.js'));
        const style = this.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'data.css'));
        const csp = [
            'default-src \'none\'',
            `style-src ${this.webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${style}">
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        clearTimeout(this.changeTimer);
        const names = [...this.resultNames];
        this.lanesUsed.add('page');
        if (names.length) { void this.engine.request('drop', { names }, this.session('page')).catch(() => undefined); }
        for (const lane of this.lanesUsed) {
            void this.engine.request('close', {}, this.session(lane)).catch(() => undefined);
        }
        for (const d of this.disposables) { d.dispose(); }
    }
}
