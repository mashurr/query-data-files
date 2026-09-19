import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Engine } from './engine';
import { DATA_EXTENSIONS, formatOf } from './formats';
import { FlowFile, Step, parseFlow, serializeFlow } from './shared/flow';
import { FlowHostMessage, FlowViewMessage } from './shared/protocol';
import { ViewEngine } from './viewEngine';

/** The visual query builder for .qflow.json files. The document stays plain JSON, so undo, save and git work as usual. */
export class FlowEditorProvider implements vscode.CustomTextEditorProvider {
    static readonly viewType = 'queryDataFiles.flow';

    constructor(private readonly context: vscode.ExtensionContext, private readonly engine: Engine) {}

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const webview = panel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webview.html = this.html(webview);
        const lanes = new ViewEngine(this.engine);
        const folder = path.dirname(document.uri.fsPath);
        // Texts of the builder's own edits, in order; each one's change event is an echo to skip.
        // Undo, redo and other editors produce changes that aren't at the head of this queue.
        const expected: string[] = [];
        const post = (m: FlowHostMessage) => void webview.postMessage(m);
        const absolute = (file: string) => path.isAbsolute(file) ? file : path.join(folder, file);

        // DuckDB may only read files it has been allowed; flows can name files outside the workspace
        const allowSources = async (text: string) => {
            const parsed = parseFlow(text);
            if (!('flow' in parsed)) { return; }
            for (const step of parsed.flow.steps) {
                if (step.type === 'source' && step.file && !/[*?[]/.test(step.file)) {
                    await this.engine.allow(absolute(step.file)).catch(() => undefined);
                }
            }
        };

        const subscriptions = [
            lanes,
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) { return; }
                const text = document.getText();
                if (expected.length && text === expected[0]) {
                    expected.shift();
                    return;
                }
                expected.length = 0;
                post({ type: 'text', text });
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => post({ type: 'init', text: document.getText(), name: path.basename(document.fileName), folder, separator: path.sep, trusted: true })),
            webview.onDidReceiveMessage(async (m: FlowViewMessage) => {
                switch (m.type) {
                    case 'ready':
                        await allowSources(document.getText());
                        post({ type: 'init', text: document.getText(), name: path.basename(document.fileName), folder, separator: path.sep, trusted: vscode.workspace.isTrusted });
                        break;
                    case 'edit': {
                        if (m.text === document.getText()) { break; }
                        expected.push(m.text);
                        await allowSources(m.text);
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), m.text);
                        await vscode.workspace.applyEdit(edit);
                        break;
                    }
                    case 'engine':
                        if (!vscode.workspace.isTrusted && m.method !== 'describe') {
                            post({ type: 'reply', rid: m.rid, reply: { ok: false, error: { kind: 'request', message: 'Previews run once you trust this workspace.' } } });
                            break;
                        }
                        post({ type: 'reply', rid: m.rid, reply: await lanes.request(m.lane, m.method, m.params) });
                        break;
                    case 'cancel':
                        await lanes.cancel(m.lanes);
                        break;
                    case 'pickFile': {
                        const picked = await vscode.window.showOpenDialog({
                            defaultUri: vscode.Uri.file(folder), canSelectMany: false, openLabel: 'Add Source',
                            filters: { 'Data files': DATA_EXTENSIONS },
                        });
                        const file = picked?.[0]?.fsPath;
                        post({ type: 'picked', rid: m.rid, file: file ? toFlowPath(folder, file) : undefined });
                        break;
                    }
                    case 'sourceInfo': {
                        const file = absolute(m.file);
                        const format = formatOf(file);
                        if (format !== 'sqlite' && format !== 'duckdb' && format !== 'xlsx') {
                            post({ type: 'sourceInfo', rid: m.rid });
                            break;
                        }
                        await this.engine.allow(file).catch(() => undefined);
                        const reply = await lanes.request('meta', 'open', { path: file, format });
                        post(reply.ok
                            ? { type: 'sourceInfo', rid: m.rid, tables: reply.result.tables as string[] | undefined, sheets: reply.result.sheets as string[] | undefined }
                            : { type: 'sourceInfo', rid: m.rid, error: reply.error.message });
                        break;
                    }
                    case 'runExport': {
                        if (!vscode.workspace.isTrusted) { break; }
                        // DuckDB won't create the folder it writes into
                        fs.mkdirSync(path.dirname(absolute(m.file)), { recursive: true });
                        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing ${m.file}…` }, async () => {
                            for (const sql of m.setup) {
                                const setup = await lanes.request('export', 'execute', { sql });
                                if (!setup.ok) { return setup; }
                            }
                            return lanes.request('export', 'execute', { sql: m.sql });
                        });
                        post({ type: 'exported', rid: m.rid, ok: result.ok });
                        if (result.ok) {
                            const rows = Number(result.result.changed ?? 0);
                            vscode.window.showInformationMessage(`Wrote ${rows.toLocaleString()} row${rows === 1 ? '' : 's'} to ${m.file}.`, 'Open File')
                                .then(choice => { if (choice) { void vscode.commands.executeCommand('queryDataFiles.open', vscode.Uri.file(absolute(m.file))); } });
                        } else {
                            vscode.window.showErrorMessage(`Export failed: ${result.error.message}`);
                        }
                        break;
                    }
                    case 'openSql': {
                        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: m.sql });
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                        break;
                    }
                    case 'copy':
                        await vscode.env.clipboard.writeText(m.text);
                        vscode.window.setStatusBarMessage(`Copied ${m.what}`, 3000);
                        break;
                }
            }),
        ];
        panel.onDidDispose(() => subscriptions.forEach(s => s.dispose()));
    }

    private html(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
        const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${uri('media', 'data.css')}">
    <link rel="stylesheet" href="${uri('media', 'flow.css')}">
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${uri('out', 'flow.js')}"></script>
</body>
</html>`;
    }
}

/** Paths in a flow are relative to the flow file, with forward slashes, so flows move with their data */
export function toFlowPath(folder: string, file: string): string {
    const relative = path.relative(folder, file);
    return path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
}

/** A new flow file next to the workspace's first folder or a given data file */
export async function newFlow(near?: vscode.Uri): Promise<void> {
    const folder = near ? vscode.Uri.file(path.dirname(near.fsPath)) : vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, 'query.qflow.json') : undefined,
        filters: { 'Query flow': ['qflow.json'] },
        saveLabel: 'Create Flow',
    });
    if (!target) { return; }
    const file = target.fsPath.endsWith('.qflow.json') ? target : vscode.Uri.file(target.fsPath.replace(/(\.json)?$/, '.qflow.json'));
    const flow: FlowFile = { version: 1, steps: [], layout: {}, outputs: [] };
    if (near) {
        const id = path.basename(near.fsPath).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(\d)/, 's_$1') || 'source';
        const source: Step = { id, type: 'source', inputs: [], file: toFlowPath(path.dirname(file.fsPath), near.fsPath) };
        flow.steps.push(source);
        flow.layout[id] = [40, 40];
    }
    await vscode.workspace.fs.writeFile(file, Buffer.from(serializeFlow(flow), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', file, FlowEditorProvider.viewType);
}
