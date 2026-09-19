import * as vscode from 'vscode';
import * as path from 'path';
import { Engine } from './engine';
import { DATA_EXTENSIONS, formatOf } from './formats';
import { Column } from './shared/protocol';

// Workspaces with more data files than this list the first ones only
const MAX_FILES = 2000;
const REFRESH_MS = 1000;
const SESSION = 'data-files';

export type Node =
    | { kind: 'file'; uri: vscode.Uri }
    | { kind: 'table'; uri: vscode.Uri; table: string; sheet: boolean }
    | { kind: 'column'; column: Column; parent: string }
    | { kind: 'message'; text: string };

/** The Data Files view in the Explorer: every data file in the workspace, its tables and columns */
export class DataFilesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly watcher: vscode.FileSystemWatcher;
    private timer: NodeJS.Timeout | undefined;
    private truncated = false;

    constructor(private readonly engine: Engine) {
        this.watcher = vscode.workspace.createFileSystemWatcher(`**/*.{${DATA_EXTENSIONS.join(',')}}`, false, true, false);
        const refresh = () => {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.refresh(), REFRESH_MS);
        };
        this.watcher.onDidCreate(refresh);
        this.watcher.onDidDelete(refresh);
    }

    refresh() {
        this.changed.fire(undefined);
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (!node) { return this.files(); }
        if (node.kind === 'file') { return this.fileChildren(node.uri); }
        if (node.kind === 'table') { return this.tableColumns(node.uri, node.table, node.sheet); }
        return [];
    }

    private async files(): Promise<Node[]> {
        // JSON is left out: most .json files in a workspace are settings, not data
        const pattern = `**/*.{${DATA_EXTENSIONS.filter(e => e !== 'json').join(',')}}`;
        const found = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git}/**', MAX_FILES + 1);
        this.truncated = found.length > MAX_FILES;
        const files = found.slice(0, MAX_FILES).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        const nodes: Node[] = files.map(uri => ({ kind: 'file', uri }));
        if (this.truncated) { nodes.push({ kind: 'message', text: `Showing the first ${MAX_FILES.toLocaleString()} files` }); }
        return nodes;
    }

    private async open(uri: vscode.Uri, table?: string, sheet?: string): Promise<{ error: string } | { result: { tables?: string[]; sheets?: string[]; source: string | null } }> {
        const format = formatOf(uri.fsPath);
        if (!format) { return { error: 'Not a SQLite or DuckDB database' }; }
        await this.engine.allow(uri.fsPath).catch(() => undefined);
        const reply = await this.engine.request('open', { path: uri.fsPath, format, table, sheet }, SESSION).catch(err => ({
            ok: false as const, error: { message: String(err instanceof Error ? err.message : err) },
        }));
        if (!reply.ok) { return { error: reply.error.message }; }
        return { result: reply.result as { tables?: string[]; sheets?: string[]; source: string | null } };
    }

    private async fileChildren(uri: vscode.Uri): Promise<Node[]> {
        const format = formatOf(uri.fsPath);
        if (format === 'sqlite' || format === 'duckdb' || format === 'xlsx') {
            const opened = await this.open(uri);
            if ('error' in opened) { return [{ kind: 'message', text: firstLine(opened.error) }]; }
            const names = (format === 'xlsx' ? opened.result.sheets : opened.result.tables) ?? [];
            if (!names.length) { return [{ kind: 'message', text: format === 'xlsx' ? 'No sheets' : 'No tables' }]; }
            return names.map(table => ({ kind: 'table', uri, table, sheet: format === 'xlsx' }));
        }
        return this.columns(uri);
    }

    private tableColumns(uri: vscode.Uri, table: string, sheet: boolean): Promise<Node[]> {
        return sheet ? this.columns(uri, undefined, table) : this.columns(uri, table);
    }

    private async columns(uri: vscode.Uri, table?: string, sheet?: string): Promise<Node[]> {
        const opened = await this.open(uri, table, sheet);
        if ('error' in opened) { return [{ kind: 'message', text: firstLine(opened.error) }]; }
        const reply = await this.engine.request('describe', { sql: 'SELECT * FROM this' }, SESSION);
        if (!reply.ok) { return [{ kind: 'message', text: firstLine(reply.error.message) }]; }
        const parent = table ?? sheet ?? path.basename(uri.fsPath);
        return (reply.result.columns as Column[]).map(column => ({ kind: 'column', column, parent }));
    }

    getTreeItem(node: Node): vscode.TreeItem {
        switch (node.kind) {
            case 'file': {
                const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = node.uri;
                const relative = vscode.workspace.asRelativePath(path.dirname(node.uri.fsPath));
                item.description = relative === path.dirname(node.uri.fsPath) || relative === '.' ? undefined : relative;
                item.contextValue = 'dataFile';
                item.command = { command: 'queryDataFiles.open', title: 'Open', arguments: [node.uri] };
                item.tooltip = node.uri.fsPath;
                return item;
            }
            case 'table': {
                const item = new vscode.TreeItem(node.table, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon(node.sheet ? 'window' : 'table');
                item.contextValue = 'dataTable';
                return item;
            }
            case 'column': {
                const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
                item.description = node.column.type;
                item.iconPath = new vscode.ThemeIcon(iconFor(node.column.type));
                item.contextValue = 'dataColumn';
                item.tooltip = `${node.parent}.${node.column.name}: ${node.column.type}`;
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    dispose() {
        clearTimeout(this.timer);
        this.watcher.dispose();
        this.changed.dispose();
        void this.engine.request('close', {}, SESSION).catch(() => undefined);
    }
}

function firstLine(text: string): string {
    return text.split('\n')[0];
}

function iconFor(type: string): string {
    const t = type.toUpperCase();
    if (/INT|FLOAT|DOUBLE|DECIMAL|REAL|NUMERIC/.test(t) && !t.includes('[')) { return 'symbol-number'; }
    if (/DATE|TIME|INTERVAL/.test(t)) { return 'calendar'; }
    if (t === 'BOOLEAN') { return 'symbol-boolean'; }
    if (t.includes('[') || t.startsWith('STRUCT') || t.startsWith('MAP')) { return 'symbol-array'; }
    return 'symbol-string';
}

/** A query to start from for a data file (or one of its tables), with paths relative to the workspace */
export function starterQuery(uri: vscode.Uri, table?: string, sheet?: boolean): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const first = vscode.workspace.workspaceFolders?.[0];
    // The engine runs from the first workspace folder, so paths are relative to it
    const file = folder && first && folder.uri.toString() === first.uri.toString()
        ? path.relative(first.uri.fsPath, uri.fsPath).split(path.sep).join('/')
        : uri.fsPath;
    const q = (s: string) => `'${s.replace(/'/g, '\'\'')}'`;
    const format = formatOf(uri.fsPath);
    let source: string;
    if (format === 'sqlite') { source = `sqlite_scan(${q(file)}, ${q(table ?? '')})`; }
    else if (format === 'duckdb') { source = `${q(file)}`; }
    else if (format === 'xlsx') { source = `read_xlsx(${q(file)}${table && sheet ? `, sheet = ${q(table)}` : ''})`; }
    else if (format === 'tsv') { source = `read_csv(${q(file)}, delim = '\\t')`; }
    else { source = q(file); }
    if (format === 'duckdb') {
        const alias = path.basename(uri.fsPath, path.extname(uri.fsPath)).toLowerCase().replace(/[^a-z0-9_]/g, '_');
        return `ATTACH IF NOT EXISTS ${source} AS ${alias} (READ_ONLY);\nSELECT * FROM ${alias}.${table ?? 'main'} LIMIT 100;\n`;
    }
    return `SELECT *\nFROM ${source}\nLIMIT 100;\n`;
}
