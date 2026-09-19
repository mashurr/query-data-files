import * as vscode from 'vscode';
import { DataView } from './dataView';
import { Engine } from './engine';

/** Opens data files (CSV, Parquet, JSON, Excel, SQLite, DuckDB) as a table you can query */
export class DataEditorProvider implements vscode.CustomReadonlyEditorProvider {
    static readonly binaryViewType = 'queryDataFiles.data';
    static readonly textViewType = 'queryDataFiles.text';

    constructor(private readonly context: vscode.ExtensionContext, private readonly engine: Engine) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => undefined };
    }

    resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
        const view = new DataView(this.context, this.engine, panel.webview, { kind: 'file', uri: document.uri });
        panel.onDidDispose(() => view.dispose());
    }
}
