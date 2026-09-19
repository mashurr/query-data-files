import * as vscode from 'vscode';
import * as path from 'path';
import { DataEditorProvider } from './dataEditor';
import { DataFilesProvider, Node, starterQuery } from './dataFiles';
import { Engine } from './engine';
import { FlowEditorProvider, newFlow } from './flowEditor';
import { SqlRunner } from './sqlRunner';

const TEXT_FORMATS = new Set(['.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.db']);

export function activate(context: vscode.ExtensionContext) {
    const engine = new Engine(context);
    const data = new DataEditorProvider(context, engine);
    const editorOptions = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false };
    const runner = new SqlRunner(context, engine);
    const files = new DataFilesProvider(engine);

    context.subscriptions.push(
        engine,
        vscode.window.registerCustomEditorProvider(DataEditorProvider.binaryViewType, data, editorOptions),
        vscode.window.registerCustomEditorProvider(DataEditorProvider.textViewType, data, editorOptions),
        vscode.commands.registerCommand('queryDataFiles.open', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                vscode.window.showInformationMessage('Open a CSV, Parquet, JSON, Excel, SQLite or DuckDB file first.');
                return;
            }
            const viewType = TEXT_FORMATS.has(path.extname(target.fsPath).toLowerCase())
                ? DataEditorProvider.textViewType : DataEditorProvider.binaryViewType;
            return vscode.commands.executeCommand('vscode.openWith', target, viewType);
        }),
        vscode.commands.registerCommand('queryDataFiles.restartEngine', () => engine.restart()),
        vscode.window.registerCustomEditorProvider(FlowEditorProvider.viewType, new FlowEditorProvider(context, engine), { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('queryDataFiles.newFlow', (arg?: vscode.Uri | Node) => newFlow(arg instanceof vscode.Uri ? arg : arg?.kind === 'file' || arg?.kind === 'table' ? arg.uri : undefined)),
        runner,
        files,
        vscode.window.registerTreeDataProvider('queryDataFiles.files', files),
        vscode.commands.registerCommand('queryDataFiles.runQuery', () => runner.run(vscode.window.activeTextEditor)),
        vscode.commands.registerCommand('queryDataFiles.refreshFiles', () => files.refresh()),
        vscode.commands.registerCommand('queryDataFiles.newQuery', async (node?: Node) => {
            const content = node?.kind === 'file' ? starterQuery(node.uri)
                : node?.kind === 'table' ? starterQuery(node.uri, node.table, node.sheet)
                    : 'SELECT *\nFROM \'data.csv\'\nLIMIT 100;\n';
            const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
            const editor = await vscode.window.showTextDocument(document);
            const end = document.lineAt(Math.max(0, document.lineCount - 2)).range.end;
            editor.selection = new vscode.Selection(end, end);
        }),
        vscode.commands.registerCommand('queryDataFiles.copyPath', async (node?: Node) => {
            if (node?.kind === 'file' || node?.kind === 'table') {
                await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(node.uri, false));
            }
        }),
        vscode.commands.registerCommand('queryDataFiles.copyName', async (node?: Node) => {
            if (node?.kind === 'column') { await vscode.env.clipboard.writeText(node.column.name); }
            if (node?.kind === 'table') { await vscode.env.clipboard.writeText(node.table); }
        }),
    );
}

export function deactivate() {}
