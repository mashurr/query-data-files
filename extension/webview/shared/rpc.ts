// Messaging with the extension host. Engine requests get a promise for their reply.

import { EngineReply, HostMessage, Lane, ViewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
let nextRid = 1;
const pending = new Map<number, (reply: EngineReply) => void>();
let listener: ((m: HostMessage) => void) | undefined;

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    const m = e.data;
    if (m.type === 'reply') {
        const resolve = pending.get(m.rid);
        if (resolve) {
            pending.delete(m.rid);
            resolve(m.reply);
        }
        return;
    }
    listener?.(m);
});

export function onHostMessage(handler: (m: HostMessage) => void) {
    listener = handler;
}

/** For webviews with their own message types (the query builder) */
export function onRawMessage(handler: (m: { type: string }) => void) {
    listener = handler as (m: HostMessage) => void;
}

export function post(message: ViewMessage) {
    api.postMessage(message);
}

export function postRaw(message: { type: string }) {
    api.postMessage(message);
}

export function engine(lane: Lane, method: string, params: Record<string, unknown> = {}): Promise<EngineReply> {
    const rid = nextRid++;
    return new Promise(resolve => {
        pending.set(rid, resolve);
        post({ type: 'engine', rid, lane, method, params });
    });
}

export function cancel(...lanes: Lane[]) {
    post({ type: 'cancel', lanes });
}

export function saveState(state: unknown) {
    api.setState(state);
}

export function loadState<T>(): T | undefined {
    return api.getState() as T | undefined;
}
