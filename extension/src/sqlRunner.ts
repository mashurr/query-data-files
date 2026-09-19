import * as vscode from 'vscode';
import * as path from 'path';
import { DataView } from './dataView';
import { Engine } from './engine';

/** Runs SQL from .sql files into a results view beside the editor, one view per file */
export class SqlRunner implements vscode.Disposable {
    private readonly views = new Map<string, { panel: vscode.WebviewPanel; view: DataView }>();

    constructor(private readonly context: vscode.ExtensionContext, private readonly engine: Engine) {}

    async run(editor: vscode.TextEditor | undefined) {
        if (!editor) {
            vscode.window.showInformationMessage('Open a .sql file to run a query.');
            return;
        }
        if (!vscode.workspace.isTrusted) {
            vscode.window.showWarningMessage('Queries from .sql files run once you trust this workspace.', 'Manage Workspace Trust')
                .then(choice => { if (choice) { void vscode.commands.executeCommand('workbench.trust.manage'); } });
            return;
        }
        const document = editor.document;
        const selected = editor.selections.filter(s => !s.isEmpty).map(s => document.getText(s)).join('\n');
        const sql = selected.trim() ? selected : statementAt(document.getText(), document.offsetAt(editor.selection.active));
        if (!sql.trim()) {
            vscode.window.showInformationMessage('There is no SQL at the cursor to run.');
            return;
        }
        const statements = splitStatements(sql);
        const title = `Results: ${path.basename(document.fileName)}`;
        // Earlier statements (e.g. ATTACH or CREATE TEMP TABLE) run first; the last one shows its rows.
        // Running one statement also runs the ATTACH statements above it, so tables it names exist.
        const attaches = selected.trim() ? [] : attachesBefore(document.getText(), document.offsetAt(editor.selection.active));
        const setup = [...attaches, ...statements.slice(0, -1)];
        const last = statements[statements.length - 1];
        const key = document.uri.toString();
        let open = this.views.get(key);
        if (!open) {
            const panel = vscode.window.createWebviewPanel('queryDataFiles.results', title,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true });
            const folder = document.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(document.uri.fsPath)) : undefined;
            const view = new DataView(this.context, this.engine, panel.webview, { kind: 'sql', title, sql: last, setup, folder });
            open = { panel, view };
            this.views.set(key, open);
            panel.onDidDispose(() => {
                view.dispose();
                this.views.delete(key);
            });
            return;
        }
        open.panel.title = title;
        open.panel.reveal(undefined, true);
        await open.view.run(last, title, setup);
    }

    dispose() {
        for (const { panel } of this.views.values()) { panel.dispose(); }
    }
}

/** Statement boundaries: semicolons outside strings, quoted names and comments */
function boundaries(text: string): number[] {
    const ends: number[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '\'' || c === '"') {
            const close = text.indexOf(c, i + 1);
            i = close < 0 ? text.length : close + 1;
        } else if (c === '-' && text[i + 1] === '-') {
            const eol = text.indexOf('\n', i);
            i = eol < 0 ? text.length : eol + 1;
        } else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close < 0 ? text.length : close + 2;
        } else {
            if (c === ';') { ends.push(i); }
            i++;
        }
    }
    return ends;
}

export function splitStatements(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (const end of boundaries(text)) {
        out.push(text.slice(start, end));
        start = end + 1;
    }
    out.push(text.slice(start));
    return out.filter(s => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());
}

/** ATTACH statements that end before `offset` */
function attachesBefore(text: string, offset: number): string[] {
    const out: string[] = [];
    let start = 0;
    for (const end of boundaries(text)) {
        if (end >= offset) { break; }
        const statement = text.slice(start, end);
        if (/^attach\b/i.test(statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim())) { out.push(statement.trim()); }
        start = end + 1;
    }
    return out;
}

/** The statement the cursor is in, or the one just before it when the cursor sits after a semicolon */
export function statementAt(text: string, offset: number): string {
    const ends = boundaries(text);
    let start = 0;
    const pieces: { start: number; end: number }[] = [];
    for (const end of ends) {
        pieces.push({ start, end });
        start = end + 1;
    }
    pieces.push({ start, end: text.length });
    const hasCode = (p: { start: number; end: number }) => !!text.slice(p.start, p.end).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
    let index = pieces.findIndex(p => offset >= p.start && offset <= p.end);
    if (index < 0) { index = pieces.length - 1; }
    while (index > 0 && !hasCode(pieces[index])) { index--; }
    return hasCode(pieces[index]) ? text.slice(pieces[index].start, pieces[index].end).trim() : '';
}
