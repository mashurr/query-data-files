import * as vscode from 'vscode';
import { Engine } from './engine';
import { EngineReply, Lane } from './shared/protocol';

let nextViewId = 1;

/**
 * A webview's share of the engine: its own sessions (one per lane) and result tables
 * named after it, all closed and dropped when the view goes away.
 */
export class ViewEngine implements vscode.Disposable {
    readonly id = `v${nextViewId++}`;
    private readonly lanes = new Set<Lane>(['main']);
    private readonly results = new Set<string>();

    constructor(private readonly engine: Engine) {}

    session(lane: Lane): string {
        return lane === 'main' ? this.id : `${this.id}:${lane}`;
    }

    /** Result tables are shared by every view in the engine, so names carry the view's id */
    resultName(name: unknown): string {
        return `${this.id}_${typeof name === 'string' ? name : 'result'}`;
    }

    /** Sends a webview's engine request on its lane, naming result tables for this view */
    async request(lane: Lane, method: string, params: Record<string, unknown>): Promise<EngineReply> {
        this.lanes.add(lane);
        const sent = { ...params };
        if (method === 'query' || method === 'page' || method === 'export') {
            const name = this.resultName(sent.name);
            sent.name = name;
            if (method === 'query') { this.results.add(name); }
        }
        return this.engine.request(method, sent, this.session(lane)).catch(err => ({
            ok: false as const, error: { kind: 'crashed' as const, message: String(err instanceof Error ? err.message : err) },
        }));
    }

    async cancel(lanes: Lane[]) {
        await Promise.all(lanes.map(lane => this.engine.request('cancel', {}, this.session(lane)).catch(() => undefined)));
    }

    dispose() {
        const names = [...this.results];
        if (names.length) { void this.engine.request('drop', { names }, this.session('page')).catch(() => undefined); }
        this.lanes.add('page');
        for (const lane of this.lanes) {
            void this.engine.request('close', {}, this.session(lane)).catch(() => undefined);
        }
    }
}
