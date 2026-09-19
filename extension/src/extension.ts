import * as vscode from 'vscode';
import * as path from 'path';
import { DataEditorProvider } from './dataEditor';
import { Engine } from './engine';

const TEXT_FORMATS = new Set(['.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.db']);

export function activate(context: vscode.ExtensionContext) {
    const engine = new Engine(context);
    const data = new DataEditorProvider(context, engine);
    const editorOptions = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false };

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
    );
}

export function deactivate() {}
