// The flowchart: steps as boxes, connections as curves. Drag a box to move it, drag from
// a box's right edge onto another box to connect them, and zoom with Ctrl+wheel.

import { h, svg } from '../shared/dom';

export const NODE_W = 208;
export const NODE_H = 86;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
// Dragging within this many pixels of the canvas edge scrolls it
const EDGE = 40;

export interface CanvasNode {
    id: string;
    group: string;
    label: string;
    summary: string;
    footer: string;
    state: 'ok' | 'error' | 'waiting' | 'running';
    x: number;
    y: number;
    inputs: string[];
    output: boolean;
}

export interface Edge { from: string; to: string; port: number }

export interface CanvasActions {
    select(id: string | undefined): void;
    moved(id: string, x: number, y: number): void;
    connect(from: string, to: string, port: number): void;
    disconnect(edge: Edge): void;
    remove(id: string): void;
    menu(id: string, x: number, y: number): void;
}

export class Canvas {
    private readonly world = h('div', { className: 'world' });
    private readonly edgesLayer = svg('svg', { class: 'edges' });
    private readonly nodesLayer = h('div', { className: 'nodes' });
    private nodes = new Map<string, CanvasNode>();
    private edges: Edge[] = [];
    private selected: string | undefined;
    private selectedEdge: Edge | undefined;
    private zoom = 1;
    private readonly temp = svg('path', { class: 'edge temp' });

    constructor(private readonly host: HTMLElement, private readonly actions: CanvasActions) {
        host.classList.add('canvas');
        host.tabIndex = 0;
        host.setAttribute('aria-label', 'Query flow. Press Delete to remove the selected step or connection.');
        this.world.append(this.edgesLayer, this.nodesLayer);
        host.append(this.world);
        host.addEventListener('pointerdown', e => {
            if (e.target === host || e.target === this.world || e.target === this.nodesLayer || e.target === this.edgesLayer) {
                this.selectedEdge = undefined;
                this.actions.select(undefined);
            }
        });
        host.addEventListener('keydown', e => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === host) {
                e.preventDefault();
                if (this.selectedEdge) { this.actions.disconnect(this.selectedEdge); this.selectedEdge = undefined; }
                else if (this.selected) { this.actions.remove(this.selected); }
            }
        });
        host.addEventListener('wheel', e => {
            if (!e.ctrlKey && !e.metaKey) { return; }
            e.preventDefault();
            this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }, { passive: false });
    }

    get scale(): number { return this.zoom; }

    setZoom(zoom: number) {
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
        this.layout();
    }

    /** Zooms so every step fits on screen (never above 100%, nor below `floor`) */
    fit(floor = MIN_ZOOM) {
        if (!this.nodes.size) { return; }
        const { w, h: height } = this.bounds();
        this.zoom = Math.max(floor, Math.min(1, (this.host.clientWidth - 24) / w, (this.host.clientHeight - 24) / height));
        this.layout();
        this.host.scrollLeft = 0;
        this.host.scrollTop = 0;
    }

    private bounds() {
        let w = 0, height = 0;
        for (const n of this.nodes.values()) { w = Math.max(w, n.x + NODE_W + 60); height = Math.max(height, n.y + NODE_H + 40); }
        return { w: Math.max(w, 400), h: Math.max(height, 200) };
    }

    private layout() {
        const { w, h: height } = this.bounds();
        this.world.style.width = `${w * this.zoom}px`;
        this.world.style.height = `${height * this.zoom}px`;
        this.nodesLayer.style.transform = `scale(${this.zoom})`;
        this.edgesLayer.setAttribute('width', String(w * this.zoom));
        this.edgesLayer.setAttribute('height', String(height * this.zoom));
        this.edgesLayer.setAttribute('viewBox', `0 0 ${w} ${height}`);
    }

    render(nodes: CanvasNode[], edges: Edge[], selected: string | undefined) {
        this.nodes = new Map(nodes.map(n => [n.id, n]));
        this.edges = edges;
        this.selected = selected;
        if (this.selectedEdge && !edges.some(e => sameEdge(e, this.selectedEdge!))) { this.selectedEdge = undefined; }
        this.nodesLayer.replaceChildren(...nodes.map(n => this.nodeElement(n)));
        this.drawEdges();
        this.layout();
    }

    /** Scrolls a step into view */
    reveal(id: string) {
        const n = this.nodes.get(id);
        if (!n) { return; }
        const x = n.x * this.zoom, y = n.y * this.zoom, s = this.host;
        if (x < s.scrollLeft || x + NODE_W * this.zoom > s.scrollLeft + s.clientWidth) { s.scrollLeft = Math.max(0, x - 40); }
        if (y < s.scrollTop || y + NODE_H * this.zoom > s.scrollTop + s.clientHeight) { s.scrollTop = Math.max(0, y - 40); }
    }

    private portY(node: CanvasNode, port: number): number {
        const count = Math.max(1, node.inputs.length);
        return count === 1 ? NODE_H / 2 : 26 + port * (NODE_H - 52) / (count - 1);
    }

    private drawEdges() {
        const paths: SVGElement[] = [];
        for (const edge of this.edges) {
            const a = this.nodes.get(edge.from), b = this.nodes.get(edge.to);
            if (!a || !b) { continue; }
            const d = curve(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + this.portY(b, edge.port));
            const active = this.selected === edge.from || this.selected === edge.to;
            const chosen = this.selectedEdge && sameEdge(edge, this.selectedEdge);
            const hit = svg('path', { class: 'edge-hit', d });
            hit.addEventListener('pointerdown', e => {
                e.stopPropagation();
                this.selectedEdge = edge;
                this.host.focus();
                this.drawEdges();
            });
            hit.append(svg('title', {}, 'Click, then press Delete to remove this connection'));
            paths.push(svg('path', { class: `edge${active ? ' active' : ''}${chosen ? ' chosen' : ''}`, d }), hit);
        }
        this.edgesLayer.replaceChildren(...paths, this.temp);
    }

    private nodeElement(n: CanvasNode): HTMLElement {
        const el = h('div', {
            className: `node ${n.group}${n.id === this.selected ? ' selected' : ''} ${n.state}`,
            style: `left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px`,
            'data-id': n.id, role: 'button', 'aria-label': `${n.label} ${n.id}: ${n.summary}`,
        },
        h('div', { className: 'node-head' }, h('span', { className: 'node-kind', text: n.label }), h('span', { className: 'node-id', text: n.id })),
        h('div', { className: 'node-summary', text: n.summary, title: n.summary }),
        h('div', { className: 'node-foot', text: n.footer, title: n.footer }));
        n.inputs.forEach((label, port) => {
            const p = h('span', { className: 'port in', style: `top:${this.portY(n, port) - 7}px`, 'data-port': port, title: `Input: drop a connection here` });
            if (label) { p.append(h('span', { className: 'port-label', text: label })); }
            el.append(p);
        });
        if (n.output) {
            const out = h('span', { className: 'port out', style: `top:${NODE_H / 2 - 7}px`, title: 'Drag to another step to connect' });
            out.addEventListener('pointerdown', e => this.startConnect(e, n));
            el.append(out);
        }
        el.addEventListener('pointerdown', e => this.startMove(e, n, el));
        el.addEventListener('contextmenu', e => { e.preventDefault(); this.actions.select(n.id); this.actions.menu(n.id, e.clientX, e.clientY); });
        return el;
    }

    /** Scrolls the canvas while a drag nears its edge, so off-screen steps can be reached */
    private edgeScroll(e: PointerEvent) {
        const r = this.host.getBoundingClientRect();
        const step = (d: number) => d < EDGE ? Math.round((EDGE - d) / 2) : 0;
        this.host.scrollLeft += step(r.right - e.clientX) - step(e.clientX - r.left);
        this.host.scrollTop += step(r.bottom - e.clientY) - step(e.clientY - r.top);
    }

    private point(e: PointerEvent): [number, number] {
        const r = this.world.getBoundingClientRect();
        return [(e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom];
    }

    private startMove(e: PointerEvent, n: CanvasNode, el: HTMLElement) {
        if (e.button !== 0 || (e.target as HTMLElement).classList.contains('port')) { return; }
        e.preventDefault();
        this.host.focus();
        const [sx, sy] = [e.clientX, e.clientY];
        const [ox, oy] = [n.x, n.y];
        let moved = false;
        el.setPointerCapture(e.pointerId);
        const [sl, st] = [this.host.scrollLeft, this.host.scrollTop];
        const move = (ev: PointerEvent) => {
            this.edgeScroll(ev);
            const dx = (ev.clientX - sx + this.host.scrollLeft - sl) / this.zoom, dy = (ev.clientY - sy + this.host.scrollTop - st) / this.zoom;
            if (!moved && Math.hypot(dx, dy) < 4) { return; }
            moved = true;
            n.x = Math.max(0, Math.round(ox + dx));
            n.y = Math.max(0, Math.round(oy + dy));
            el.style.left = `${n.x}px`;
            el.style.top = `${n.y}px`;
            this.drawEdges();
        };
        const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            if (moved) {
                this.layout();
                this.actions.moved(n.id, n.x, n.y);
            } else {
                this.selectedEdge = undefined;
                this.actions.select(n.id);
            }
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
    }

    private startConnect(e: PointerEvent, from: CanvasNode) {
        e.preventDefault();
        e.stopPropagation();
        const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
        const move = (ev: PointerEvent) => {
            this.edgeScroll(ev);
            const [x, y] = this.point(ev);
            this.temp.setAttribute('d', curve(x1, y1, x, y));
            this.nodesLayer.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'));
            (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.node')?.classList.add('drop');
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            this.temp.setAttribute('d', '');
            this.nodesLayer.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'));
            const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
            const nodeEl = target?.closest('.node') as HTMLElement | null;
            const to = nodeEl?.dataset.id;
            if (!to || to === from.id) { return; }
            const node = this.nodes.get(to)!;
            if (!node.inputs.length) { return; }
            const portEl = target?.closest('.port.in') as HTMLElement | null;
            let port = portEl ? Number(portEl.dataset.port) : this.edges.filter(x => x.to === to).length;
            if (port >= node.inputs.length) { port = node.inputs.length - 1; }
            this.actions.connect(from.id, to, port);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function sameEdge(a: Edge, b: Edge): boolean {
    return a.from === b.from && a.to === b.to && a.port === b.port;
}
