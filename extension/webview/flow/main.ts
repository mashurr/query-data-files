// The query builder: a flowchart of steps, the selected step's settings, and a preview
// of its rows. Every edit is written straight to the .qflow.json document.

import { Column, FlowHostMessage, FlowViewMessage, QueryResult } from '../../src/shared/protocol';
import {
    CompileContext, FlowError, FlowFile, STEPS, Step, StepType, checkInputs, compile, defaultBody, emptyRows, exportSql,
    formatOfName, newId, parseFlow, serializeFlow, upstream,
} from '../../src/shared/flow';
import { formatCount, formatMs, h } from '../shared/dom';
import { showMenu } from '../shared/menu';
import { cancel, engine, onRawMessage, postRaw } from '../shared/rpc';
import { decode, Decoded } from '../shared/values';
import { ChartSettings, ChartView } from '../data/chart';
import { Grid, PAGE_ROWS } from '../data/grid';
import { Profile, computeProfiles, resultTable } from '../data/profile';
import { Canvas, CanvasNode, Edge, NODE_H, NODE_W } from './canvas';
import { renderInspector } from './inspector';

const TYPING_MS = 400;
const PREVIEW_MS = 250;
const COLUMN_GAP = 256;
const ROW_GAP = 112;
const PREVIEW_CACHE = 4;
// Opening a flow zooms out to fit it, but not below this; further out, text is unreadable
const AUTO_FIT_MIN = 0.6;
const TOAST_MS = 4000;

interface StepState {
    sql?: string;
    setup?: string[];
    columns?: Column[];
    error?: string;
    rows?: number;
}

const post = (m: FlowViewMessage) => postRaw(m);

class FlowApp {
    private flow: FlowFile = { version: 1, steps: [], layout: {} };
    private lastText = '';
    private folder = '';
    private separator = '/';
    private trusted = false;
    private selected: string | undefined;
    private readonly states = new Map<string, StepState>();
    private readonly described = new Map<string, Promise<{ columns?: Column[]; error?: string }>>();
    private readonly sourceChoices = new Map<string, { kind: 'table' | 'sheet'; names: string[] } | { error: string }>();
    private describeToken = 0;
    private editTimer = 0;
    private previewTimer = 0;
    private previewToken = 0;
    private previewTab: 'table' | 'chart' | 'sql' = 'table';
    /** The Chart tab was opened because a Chart step was selected, not by the person */
    private autoChart = false;
    private readonly previews: { sql: string; name: string; result: QueryResult; first: Decoded }[] = [];
    private nextPreview = 0;
    private profiles: (Profile | undefined)[] = [];
    private nextRid = 1;
    private readonly waiting = new Map<number, (m: FlowHostMessage) => void>();

    private readonly title = h('span', { className: 'title' });
    private readonly note = h('span', { className: 'meta' });
    private readonly banner = h('div', { className: 'message warning', hidden: true });
    private readonly canvasHost = h('div', { className: 'canvas-host' });
    private readonly inspectorHost = h('aside', { className: 'inspector', 'aria-label': 'Step settings' });
    private readonly previewHead = h('div', { className: 'preview-head' });
    private readonly previewTabs = h('div', { className: 'tabs', role: 'tablist' });
    private readonly previewGrid = h('div', { className: 'content' });
    private readonly previewChart = h('div', { className: 'content', hidden: true });
    private readonly previewSql = h('div', { className: 'content sql-view', hidden: true });
    private readonly previewMessage = h('div', { className: 'message', hidden: true });
    private readonly canvas: Canvas;
    private readonly grid: Grid;
    private readonly chart: ChartView;
    private readonly zoomLabel = h('span', { className: 'zoom', text: '100%' });
    private readonly toast = h('div', { className: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });
    private toastTimer = 0;

    constructor(root: HTMLElement) {
        const add = h('button', { className: 'primary', text: '+ Add Step' });
        add.addEventListener('click', e => this.addMenu(e.currentTarget as HTMLElement));
        const tidy = this.toolButton('Tidy', 'Lay the steps out in columns', () => this.tidy());
        const fit = this.toolButton('Fit', 'Zoom to fit every step', () => { this.canvas.fit(); this.showZoom(); });
        const zoomOut = this.toolButton('−', 'Zoom out (Ctrl+wheel)', () => this.zoomBy(1 / 1.2));
        const zoomIn = this.toolButton('+', 'Zoom in (Ctrl+wheel)', () => this.zoomBy(1.2));
        const copy = this.toolButton('Copy SQL', 'Copy the SQL for the selected step and everything before it', () => this.copySql());
        const openSql = this.toolButton('Open as SQL', 'Open the selected step\'s SQL in a new editor', () => this.openSql());
        const preview = h('section', { className: 'preview', 'aria-label': 'Preview' }, this.previewHead, this.previewTabs, this.previewMessage, this.previewGrid, this.previewChart, this.previewSql);
        root.append(
            h('div', { className: 'toolbar' }, this.title, add, tidy, fit, zoomOut, this.zoomLabel, zoomIn, h('span', { className: 'spacer' }), this.note, copy, openSql),
            this.banner,
            this.canvasHost,
            h('div', { className: 'flow-bottom' }, this.inspectorHost, preview),
            this.toast,
        );
        this.canvas = new Canvas(this.canvasHost, {
            select: id => this.select(id),
            moved: (id, x, y) => this.commit(() => { this.flow.layout[id] = [x, y]; }, { layoutOnly: true }),
            connect: (from, to, port) => this.connect(from, to, port),
            disconnect: edge => this.commit(() => {
                const step = this.step(edge.to);
                if (step) { step.inputs[edge.port] = ''; trimInputs(step); }
            }),
            remove: id => this.remove(id),
            menu: (id, x, y) => this.stepMenu(id, x, y),
        });
        this.canvasHost.addEventListener('wheel', () => this.showZoom(), { passive: true });
        this.grid = new Grid(this.previewGrid, {
            headerClick: () => undefined,
            headerMenu: () => undefined,
            cellMenu: () => undefined,
            copyCell: cell => {
                const shown = this.shownPreview();
                if (shown) { post({ type: 'copy', text: String(cell.value ?? ''), what: 'the value' }); }
            },
        });
        this.chart = new ChartView(this.previewChart, settings => this.chartChanged(settings), () => undefined);
        onRawMessage(m => this.receive(m as FlowHostMessage));
        post({ type: 'ready' });
    }

    private toolButton(label: string, title: string, run: () => void) {
        const b = h('button', { className: 'secondary', text: label, title });
        b.addEventListener('click', run);
        return b;
    }

    /** Zooms from the buttons, keeping the selected step on screen */
    private zoomBy(factor: number) {
        this.canvas.setZoom(this.canvas.scale * factor);
        if (this.selected) { this.canvas.reveal(this.selected); }
        this.showZoom();
    }

    private showZoom() { this.zoomLabel.textContent = `${Math.round(this.canvas.scale * 100)}%`; }

    private ask<T extends FlowHostMessage>(build: (rid: number) => FlowViewMessage): Promise<T> {
        const rid = this.nextRid++;
        return new Promise(resolve => {
            this.waiting.set(rid, m => resolve(m as T));
            post(build(rid));
        });
    }

    private receive(m: FlowHostMessage) {
        switch (m.type) {
            case 'init':
                this.folder = m.folder;
                this.separator = m.separator;
                this.trusted = m.trusted;
                this.title.textContent = m.name;
                this.banner.hidden = m.trusted;
                this.banner.textContent = 'Previews and exports run once you trust this workspace. You can still build and edit the flow.';
                this.load(m.text, true);
                break;
            case 'text':
                if (m.text !== this.lastText) { this.load(m.text, false); }
                break;
            case 'picked': case 'sourceInfo': case 'exported':
                this.waiting.get(m.rid)?.(m);
                this.waiting.delete(m.rid);
                break;
            case 'reply':
                break;
        }
    }

    private load(text: string, first: boolean) {
        this.lastText = text;
        const parsed = parseFlow(text);
        if ('error' in parsed) {
            this.banner.hidden = false;
            this.banner.className = 'message error';
            this.banner.textContent = `${parsed.error} Fix it in a text editor (Reopen Editor With… › Text Editor), or undo.`;
            return;
        }
        this.banner.className = 'message warning';
        this.banner.hidden = this.trusted;
        this.flow = parsed.flow;
        for (const step of this.flow.steps) {
            if (!this.flow.layout[step.id]) { this.flow.layout[step.id] = this.freeSpot(40, 40); }
        }
        if (this.selected && !this.step(this.selected)) { this.selected = undefined; }
        if (first) {
            this.selected = this.flow.steps.find(s => !STEPS[s.type].output)?.id ?? this.flow.steps.at(-1)?.id;
            if (this.step(this.selected)?.type === 'chart') { this.previewTab = 'chart'; this.autoChart = true; }
        }
        this.refresh();
        if (first) {
            requestAnimationFrame(() => {
                const bounds = this.canvasHost;
                const tooWide = this.flow.steps.some(s => (this.flow.layout[s.id][0] + NODE_W) > bounds.clientWidth || (this.flow.layout[s.id][1] + NODE_H) > bounds.clientHeight);
                if (tooWide) { this.canvas.fit(AUTO_FIT_MIN); this.showZoom(); }
                if (this.selected) { this.canvas.reveal(this.selected); }
            });
        }
    }

    private step(id: string | undefined): Step | undefined {
        return this.flow.steps.find(s => s.id === id);
    }

    /** Where a file named in the flow is on disk: relative to the flow file */
    private path(file: string): string {
        if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(file)) { return file; }
        return `${this.folder}${this.separator}${file.split('/').join(this.separator)}`;
    }

    private context(relative = false): CompileContext {
        return {
            path: file => relative ? file : this.path(file),
            columns: id => this.states.get(id)?.columns,
        };
    }

    /** Applies an edit, writes the document and refreshes what depends on it */
    private commit(update: () => void, options: { typing?: boolean; layoutOnly?: boolean } = {}) {
        update();
        this.writeOutputs();
        const text = serializeFlow(this.flow);
        this.lastText = text;
        clearTimeout(this.editTimer);
        if (options.typing) {
            this.editTimer = window.setTimeout(() => post({ type: 'edit', text }), TYPING_MS);
        } else {
            post({ type: 'edit', text });
        }
        if (options.layoutOnly) { return; }
        this.refresh(options.typing);
    }

    /** The SQL `qdf-engine run` needs, with paths as written (the CLI runs from the flow's folder) */
    private writeOutputs() {
        const outputs: NonNullable<FlowFile['outputs']> = [];
        const ctx = this.context(true);
        for (const step of this.flow.steps) {
            if (STEPS[step.type].output) { continue; }
            try {
                const compiled = step.type === 'export' ? exportSql(this.flow.steps, step, ctx) : compile(this.flow.steps, step.id, ctx);
                outputs.push({ step: step.id, kind: step.type as 'table' | 'chart' | 'export', ...(compiled.setup.length ? { setup: compiled.setup } : {}), sql: compiled.sql, ...(step.type === 'export' ? { file: step.file } : {}) });
            } catch {
                // Unfinished outputs are left out until they compile
            }
        }
        this.flow.outputs = outputs;
    }

    /** Works out each step's SQL and columns, in order, then redraws */
    private refresh(typing = false) {
        const token = ++this.describeToken;
        this.draw();
        void (async () => {
            const order = this.order();
            // Sources are independent: read their columns all at once
            const sources = order.filter(s => s.type === 'source').map(step => {
                try {
                    const compiled = compile(this.flow.steps, step.id, this.context());
                    return this.describeCached(compiled.setup, compiled.sql);
                } catch {
                    return undefined;
                }
            });
            await Promise.all(sources);
            for (const step of order) {
                if (token !== this.describeToken) { return; }
                const state: StepState = {};
                try {
                    checkInputs(step);
                    const inputStates = step.inputs.map(i => this.states.get(i));
                    if (inputStates.some(s => !s || s.error || !s.columns)) {
                        throw new FlowError(step.id, 'Waiting for the step before it');
                    }
                    const compiled = compile(this.flow.steps, step.id, this.context());
                    state.sql = compiled.sql;
                    state.setup = compiled.setup;
                    let d = await this.describeFast(step, compiled);
                    if (d.error && step.type !== 'source') {
                        // An empty stand-in can fail where the real data wouldn't; check with the files
                        d = await this.describeCached(compiled.setup, compiled.sql);
                    }
                    if (d.error) { state.error = d.error; } else { state.columns = d.columns; }
                } catch (err) {
                    state.error = err instanceof Error ? err.message : String(err);
                }
                const old = this.states.get(step.id);
                state.rows = old?.sql === state.sql ? old?.rows : undefined;
                this.states.set(step.id, state);
                if (token !== this.describeToken) { return; }
                this.drawNode();
            }
            this.draw(typing);
            this.schedulePreview();
        })();
    }

    private describeCached(setup: string[], sql: string): Promise<{ columns?: Column[]; error?: string }> {
        const key = `${setup.join(';\n')}\n${sql}`;
        let pending = this.described.get(key);
        if (!pending) {
            pending = this.describe(setup, sql);
            this.described.set(key, pending);
        }
        return pending;
    }

    /**
     * A step's columns without reading files: sources are replaced by empty rows of their
     * known columns. Pivots make columns from the data, so steps after one read the files.
     */
    private describeFast(step: Step, compiled: { setup: string[]; sql: string }) {
        const chain = upstream(this.flow.steps, step.id);
        if (step.type === 'source' || chain.some(s => s.type === 'pivot')) {
            return this.describeCached(compiled.setup, compiled.sql);
        }
        const stubbed = compile(this.flow.steps, step.id, {
            ...this.context(),
            stub: source => {
                const columns = this.states.get(source.id)?.columns;
                return columns ? emptyRows(columns) : undefined;
            },
        });
        return this.describeCached(stubbed.setup, stubbed.sql);
    }

    private async describe(setup: string[], sql: string): Promise<{ columns?: Column[]; error?: string }> {
        for (const statement of setup) {
            const r = await engine('describe', 'query', { sql: statement, name: 'setup'});
            if (!r.ok) { return { error: r.error.message }; }
        }
        const reply = await engine('describe', 'describe', { sql });
        return reply.ok ? { columns: reply.result.columns as Column[] } : { error: reply.error.message };
    }

    /** Steps in an order where inputs come first; steps in a loop are reported, not visited */
    private order(): Step[] {
        const out: Step[] = [];
        const seen = new Set<string>();
        for (const step of this.flow.steps) {
            try {
                for (const s of upstream(this.flow.steps, step.id)) {
                    if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
                }
            } catch {
                if (!seen.has(step.id)) { seen.add(step.id); out.push(step); }
            }
        }
        return out;
    }

    private drawNode() {
        this.draw(true);
    }

    private draw(keepInspector = false) {
        const nodes: CanvasNode[] = this.flow.steps.map(step => {
            const info = STEPS[step.type];
            const state = this.states.get(step.id);
            const [x, y] = this.flow.layout[step.id] ?? [40, 40];
            const waiting = state?.error === 'Waiting for the step before it';
            let footer = '';
            if (!state) { footer = 'Working out columns…'; }
            else if (state.error) { footer = waiting ? 'Waiting for the step before it' : `⚠ ${state.error.split('\n')[0]}`; }
            else { footer = `${state.columns?.length ?? 0} columns${state.rows !== undefined ? ` · ${formatCount(state.rows)} rows` : ''}`; }
            return {
                id: step.id, group: info.group.replace(/\s+/g, '-').toLowerCase(), label: info.label, summary: summary(step),
                footer, state: !state ? 'running' : state.error ? (waiting ? 'waiting' : 'error') : 'ok', x, y,
                inputs: info.inputs === 2 ? (step.type === 'join' ? ['L', 'R'] : ['1', '2']) : info.inputs === 1 ? [''] : [],
                output: info.output,
            };
        });
        const edges: Edge[] = [];
        for (const step of this.flow.steps) {
            step.inputs.forEach((from, port) => { if (from && this.step(from)) { edges.push({ from, to: step.id, port }); } });
        }
        this.canvas.render(nodes, edges, this.selected);
        const errors = [...this.states.values()].filter(s => s.error && s.error !== 'Waiting for the step before it').length;
        this.note.textContent = `${this.flow.steps.length} step${this.flow.steps.length === 1 ? '' : 's'}${errors ? ` · ${errors} with problems` : ''}`;
        if (!keepInspector || !this.inspectorHost.contains(document.activeElement)) { this.drawInspector(); }
    }

    private drawInspector() {
        const step = this.step(this.selected);
        if (!step) {
            this.inspectorHost.replaceChildren(h('div', { className: 'empty-inspector' },
                h('p', { text: this.flow.steps.length ? 'Select a step to change its settings.' : 'Start with a source: a CSV, Parquet, JSON, Excel, SQLite or DuckDB file.' }),
                this.flow.steps.length ? null : (() => { const b = h('button', { className: 'primary', text: 'Add a Source…' }); b.addEventListener('click', () => void this.addSource()); return b; })()));
            return;
        }
        const state = this.states.get(step.id);
        if (step.type === 'source' && formatOfName(step.file) && ['sqlite', 'duckdb', 'xlsx'].includes(formatOfName(step.file)!) && !this.sourceChoices.has(step.file)) {
            void this.loadSourceChoices(step.file);
        }
        renderInspector(this.inspectorHost, {
            step,
            inputs: step.inputs.map(i => this.states.get(i)?.columns),
            inputNames: step.inputs,
            error: state?.error && state.error !== 'Waiting for the step before it' ? state.error : undefined,
            trusted: this.trusted,
            sourceChoices: step.type === 'source' ? this.sourceChoices.get(step.file) : undefined,
            change: (update, options) => this.commit(() => update(step), options),
            rename: id => this.rename(step, id),
            remove: () => this.remove(step.id),
            pickFile: () => void this.pickFileFor(step),
            runExport: () => void this.runExport(step),
        });
    }

    private async loadSourceChoices(file: string) {
        const m = await this.ask<Extract<FlowHostMessage, { type: 'sourceInfo' }>>(rid => ({ type: 'sourceInfo', rid, file }));
        this.sourceChoices.set(file, m.error ? { error: m.error.split('\n')[0] } : m.sheets ? { kind: 'sheet', names: m.sheets } : { kind: 'table', names: m.tables ?? [] });
        if (this.step(this.selected)?.type === 'source') { this.drawInspector(); }
    }

    private rename(step: Step, id: string): string | undefined {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) { return 'Use letters, digits and underscores, starting with a letter'; }
        if (id === step.id) { return undefined; }
        if (this.step(id)) { return `Another step is called ${id}`; }
        const old = step.id;
        this.commit(() => {
            step.id = id;
            for (const s of this.flow.steps) { s.inputs = s.inputs.map(i => i === old ? id : i); }
            this.flow.layout[id] = this.flow.layout[old];
            delete this.flow.layout[old];
            if (this.selected === old) { this.selected = id; }
        });
        return undefined;
    }

    private select(id: string | undefined) {
        if (id === this.selected) { return; }
        this.selected = id;
        const step = this.step(id);
        if (step?.type === 'chart' && this.previewTab !== 'chart') { this.previewTab = 'chart'; this.autoChart = true; }
        else if (step?.type !== 'chart' && this.autoChart) { this.previewTab = 'table'; this.autoChart = false; }
        this.draw();
        this.schedulePreview();
        if (id) { this.canvas.reveal(id); }
    }

    private connect(from: string, to: string, port: number) {
        const target = this.step(to);
        if (!target) { return; }
        try {
            upstream(this.flow.steps.map(s => s.id === to ? { ...s, inputs: replaceAt(s.inputs, port, from) } : s), to);
        } catch {
            this.flash('That connection would make a loop, so it wasn\'t added.');
            return;
        }
        this.commit(() => { target.inputs = replaceAt(target.inputs, port, from); });
    }

    private remove(id: string) {
        const step = this.step(id);
        if (!step) { return; }
        this.commit(() => {
            const replacement = STEPS[step.type].inputs === 1 ? step.inputs[0] ?? '' : '';
            this.flow.steps = this.flow.steps.filter(s => s.id !== id);
            for (const s of this.flow.steps) {
                s.inputs = s.inputs.map(i => i === id ? replacement : i);
                trimInputs(s);
            }
            delete this.flow.layout[id];
            if (this.selected === id) { this.selected = replacement || undefined; }
        });
    }

    private freeSpot(x: number, y: number): [number, number] {
        const taken = (px: number, py: number) => Object.values(this.flow.layout).some(([lx, ly]) => Math.abs(lx - px) < NODE_W && Math.abs(ly - py) < NODE_H + 10);
        while (taken(x, y)) { y += ROW_GAP; }
        return [x, y];
    }

    private addMenu(anchor: HTMLElement) {
        const rect = anchor.getBoundingClientRect();
        const groups = new Map<string, StepType[]>();
        for (const [type, info] of Object.entries(STEPS) as [StepType, typeof STEPS[StepType]][]) {
            groups.set(info.group, [...(groups.get(info.group) ?? []), type]);
        }
        const selected = this.step(this.selected);
        const items: Parameters<typeof showMenu>[2] = [];
        for (const [group, types] of groups) {
            if (items.length) { items.push('separator'); }
            for (const type of types) {
                items.push({
                    label: `${group}: ${STEPS[type].label}${type === 'source' ? '…' : ''}`,
                    disabled: type !== 'source' && !this.flow.steps.length,
                    run: () => type === 'source' ? void this.addSource() : this.addStep(type, selected),
                });
            }
        }
        showMenu(rect.left, rect.bottom + 2, items);
    }

    private async addSource() {
        const m = await this.ask<Extract<FlowHostMessage, { type: 'picked' }>>(rid => ({ type: 'pickFile', rid }));
        if (!m.file) { return; }
        const file = m.file;
        const id = newId(this.flow.steps, 'source', file.split('/').pop());
        const selected = this.step(this.selected);
        this.commit(() => {
            const step = { id, inputs: [], ...defaultBody('source'), file } as Step;
            this.flow.steps.push(step);
            const others = this.flow.steps.filter(s => s.type === 'source' && s.id !== id).map(s => this.flow.layout[s.id]);
            this.flow.layout[id] = this.freeSpot(40, others.length ? Math.max(...others.map(p => p[1])) + ROW_GAP : 40);
            // A join or union waiting for its second input gets the new source
            if (selected && STEPS[selected.type].inputs === 2 && !selected.inputs[1]) { selected.inputs[1] = id; }
            else { this.selected = id; }
        });
    }

    private addStep(type: StepType, after: Step | undefined) {
        const id = newId(this.flow.steps, type);
        this.commit(() => {
            const step = { id, inputs: [], ...defaultBody(type) } as Step;
            if (after && STEPS[after.type].output) {
                step.inputs = [after.id];
                // Steps that read from `after` now read from the new step, so it slots into the chain
                if (STEPS[type].inputs === 1 && STEPS[type].output) {
                    for (const s of this.flow.steps) { s.inputs = s.inputs.map(i => i === after.id ? id : i); }
                }
                if (STEPS[type].inputs === 2) { step.inputs.push(''); }
                const [x, y] = this.flow.layout[after.id];
                for (const [other, pos] of Object.entries(this.flow.layout)) {
                    if (pos[0] > x && other !== after.id && this.flow.steps.find(s => s.id === other)?.inputs.includes(id)) { pos[0] += COLUMN_GAP; }
                }
                this.flow.layout[id] = this.freeSpot(x + COLUMN_GAP, y);
            } else {
                this.flow.layout[id] = this.freeSpot(40 + COLUMN_GAP, 40);
            }
            this.flow.steps.push(step);
            if (type === 'group') {
                const input = this.states.get(step.inputs[0] ?? '')?.columns;
                const measure = input?.find(c => /INT|DOUBLE|DECIMAL|FLOAT/.test(c.type) && !/(^id$|_id$)/i.test(c.name));
                if (step.type === 'group' && measure) { step.aggregates.push({ fn: 'sum', column: measure.name, as: `total_${measure.name}` }); }
            }
            this.selected = id;
            if (type === 'chart') { this.previewTab = 'chart'; this.autoChart = true; }
        });
    }

    /**
     * Lays steps out in columns: each step one column after its last input, then pulled
     * right to sit just before the first step that uses it, so sources stay near their use.
     * Within a column, steps line up with the steps they connect to.
     */
    private tidy() {
        const steps = this.flow.steps;
        const byId = new Map(steps.map(s => [s.id, s]));
        const consumers = new Map<string, Step[]>(steps.map(s => [s.id, []]));
        for (const s of steps) { for (const i of s.inputs) { consumers.get(i)?.push(s); } }
        const depth = new Map<string, number>();
        const depthOf = (id: string, seen = new Set<string>()): number => {
            if (depth.has(id)) { return depth.get(id)!; }
            if (seen.has(id)) { return 0; }
            seen.add(id);
            const step = byId.get(id);
            const d = step ? Math.max(0, ...step.inputs.filter(i => byId.has(i)).map(i => depthOf(i, seen) + 1)) : 0;
            depth.set(id, d);
            return d;
        };
        steps.forEach(s => depthOf(s.id));
        for (const step of [...steps].sort((a, b) => depth.get(b.id)! - depth.get(a.id)!)) {
            const uses = consumers.get(step.id)!;
            if (uses.length) { depth.set(step.id, Math.max(depth.get(step.id)!, Math.min(...uses.map(u => depth.get(u.id)!)) - 1)); }
        }
        const columns: Step[][] = [];
        for (const step of steps) { (columns[depth.get(step.id)!] ??= []).push(step); }
        const row = new Map<string, number>();
        const average = (ids: string[]) => {
            const ys = ids.map(i => row.get(i)).filter((v): v is number => v !== undefined);
            return ys.length ? ys.reduce((a, b) => a + b) / ys.length : undefined;
        };
        const place = (column: Step[], key: (s: Step) => number | undefined) => {
            column.sort((a, b) => (key(a) ?? 1e9) - (key(b) ?? 1e9));
            column.forEach((s, i) => row.set(s.id, i));
        };
        // Left to right by inputs, right to left by consumers, then left to right again
        for (const column of columns) { if (column) { place(column, s => average(s.inputs)); } }
        for (const column of [...columns].reverse()) { if (column) { place(column, s => average(consumers.get(s.id)!.map(c => c.id)) ?? row.get(s.id)); } }
        for (const column of columns) { if (column) { place(column, s => average(s.inputs) ?? row.get(s.id)); } }
        this.commit(() => {
            columns.forEach((column, d) => column?.forEach(step => {
                this.flow.layout[step.id] = [40 + d * COLUMN_GAP, 40 + row.get(step.id)! * ROW_GAP];
            }));
        }, { layoutOnly: true });
        this.draw();
    }

    private stepMenu(id: string, x: number, y: number) {
        showMenu(x, y, [
            { label: 'Copy SQL up to Here', run: () => { this.selected = id; this.copySql(); } },
            { label: 'Open as SQL', run: () => { this.selected = id; this.openSql(); } },
            'separator',
            { label: 'Delete Step', run: () => this.remove(id) },
        ]);
    }

    private compiledSelected(relative = true) {
        const step = this.step(this.selected);
        if (!step) { this.flash('Select a step first.'); return undefined; }
        try {
            const compiled = step.type === 'export' ? exportSql(this.flow.steps, step, this.context(relative)) : compile(this.flow.steps, step.id, this.context(relative));
            const header = `-- Generated by Query Data Files from ${this.title.textContent}, step ${step.id}\n`;
            return header + [...compiled.setup.map(s => `${s};`), `${compiled.sql};`].join('\n') + '\n';
        } catch (err) {
            this.flash(err instanceof Error ? err.message : String(err));
            return undefined;
        }
    }

    private copySql() {
        const sql = this.compiledSelected();
        if (sql) { post({ type: 'copy', text: sql, what: 'the SQL' }); }
    }

    private openSql() {
        // Paths stay relative to the flow file, so the SQL reads as it was built
        const sql = this.compiledSelected();
        if (sql) { post({ type: 'openSql', sql }); }
    }

    private async pickFileFor(step: Step) {
        const m = await this.ask<Extract<FlowHostMessage, { type: 'picked' }>>(rid => ({ type: 'pickFile', rid }));
        if (m.file && step.type === 'source') {
            const file = m.file;
            this.commit(() => { if (step.type === 'source') { step.file = file; step.table = undefined; step.sheet = undefined; } });
        }
    }

    private async runExport(step: Step) {
        if (step.type !== 'export') { return; }
        try {
            const compiled = exportSql(this.flow.steps, step, this.context());
            await this.ask(rid => ({ type: 'runExport', rid, setup: compiled.setup, sql: compiled.sql, file: step.file }));
        } catch (err) {
            this.flash(err instanceof Error ? err.message : String(err));
        }
    }

    /** A short notice that stays a few seconds, whatever else redraws */
    private flash(text: string) {
        this.toast.textContent = text;
        this.toast.hidden = false;
        clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, TOAST_MS);
    }

    // ---------- Preview ----------

    private schedulePreview() {
        clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => void this.preview(), PREVIEW_MS);
    }

    private shownPreview() {
        const state = this.states.get(this.selected ?? '');
        return this.previews.find(p => p.sql === state?.sql);
    }

    private renderPreviewTabs() {
        const tab = (id: 'table' | 'chart' | 'sql', label: string) => {
            const b = h('button', { role: 'tab', 'aria-selected': String(this.previewTab === id), className: this.previewTab === id ? 'active' : '', text: label });
            b.addEventListener('click', () => { this.previewTab = id; this.autoChart = false; this.renderPreviewTabs(); void this.preview(); });
            return b;
        };
        this.previewTabs.replaceChildren(tab('table', 'Table'), tab('chart', 'Chart'), tab('sql', 'SQL'));
        this.previewGrid.hidden = this.previewTab !== 'table';
        this.previewChart.hidden = this.previewTab !== 'chart';
        this.previewSql.hidden = this.previewTab !== 'sql';
    }

    private async preview() {
        const token = ++this.previewToken;
        this.renderPreviewTabs();
        this.previewMessage.hidden = true;
        const step = this.step(this.selected);
        const state = step && this.states.get(step.id);
        if (!step) {
            this.previewHead.textContent = 'Preview';
            this.grid.clear();
            return;
        }
        if (!state || !state.sql || state.error) {
            this.previewHead.textContent = `Preview of ${step.id}`;
            this.grid.clear();
            this.previewSql.replaceChildren();
            if (state?.error) {
                this.previewMessage.hidden = false;
                this.previewMessage.className = 'message error';
                this.previewMessage.replaceChildren(h('pre', { text: state.error }));
            }
            return;
        }
        this.previewSql.replaceChildren(h('pre', { text: this.compiledSelected() ?? '' }));
        if (this.previewTab === 'sql') {
            this.previewHead.textContent = `SQL for ${step.id} and every step before it`;
            return;
        }
        if (!this.trusted) {
            this.previewHead.textContent = `Preview of ${step.id}`;
            this.previewMessage.hidden = false;
            this.previewMessage.className = 'message warning';
            this.previewMessage.textContent = 'Previews run once you trust this workspace.';
            return;
        }
        let cached = this.previews.find(p => p.sql === state.sql);
        if (!cached) {
            this.previewHead.textContent = `Running ${step.id}…`;
            cancel('main', 'profile', 'chart');
            for (const sql of state.setup ?? []) {
                await engine('main', 'query', { sql, name: 'setup'});
            }
            const name = `p${this.nextPreview++ % PREVIEW_CACHE}`;
            const reply = await engine('main', 'query', { sql: state.sql, name, pageSize: PAGE_ROWS });
            if (token !== this.previewToken) { return; }
            if (!reply.ok) {
                this.previewHead.textContent = `Preview of ${step.id}`;
                if (reply.error.kind !== 'cancelled') {
                    this.previewMessage.hidden = false;
                    this.previewMessage.className = 'message error';
                    this.previewMessage.replaceChildren(h('pre', { text: reply.error.message }));
                }
                return;
            }
            const result = reply.result as unknown as QueryResult;
            const evicted = this.previews.findIndex(p => p.name === name);
            if (evicted >= 0) { this.previews.splice(evicted, 1); }
            cached = { sql: state.sql, name, result, first: decode(reply.body) };
            this.previews.push(cached);
            state.rows = result.rows;
            this.drawNode();
        }
        const { result, first, name } = cached;
        this.previewHead.textContent = `Preview of ${step.id} · ${formatCount(result.rows)} rows · ${result.columns.length} columns · ${formatMs(result.ms)}`;
        this.grid.setData({
            columns: result.columns, types: first.types, rows: result.rows, first,
            fetch: async offset => {
                const r = await engine('page', 'page', { name, offset, limit: PAGE_ROWS });
                return r.ok ? decode(r.body) : undefined;
            },
        }, true);
        const table = result.name ? resultTable(result.name) : null;
        if (this.previewTab === 'chart') {
            const settings = step.type === 'chart' ? step.chart as ChartSettings : { type: 'auto' as const };
            void this.chart.show(settings, result.columns, this.profiles, table, result.rows);
        }
        if (table && result.rows) {
            const profiles = await computeProfiles(table, result.columns, result.rows);
            if (token === this.previewToken && profiles) {
                this.profiles = profiles;
                this.grid.setProfiles(profiles);
            }
        }
    }

    private chartChanged(settings: ChartSettings) {
        const step = this.step(this.selected);
        if (step?.type === 'chart') {
            this.commit(() => { if (step.type === 'chart') { step.chart = { ...settings }; } }, { layoutOnly: true });
        }
        const cached = this.shownPreview();
        if (cached?.result.name) {
            void this.chart.show(settings, cached.result.columns, this.profiles, resultTable(cached.result.name), cached.result.rows);
        }
    }
}

function replaceAt(list: string[], index: number, value: string): string[] {
    const out = [...list];
    while (out.length < index) { out.push(''); }
    out[index] = value;
    return out;
}

function trimInputs(step: Step) {
    const needed = STEPS[step.type].inputs;
    step.inputs = step.inputs.slice(0, Math.max(needed, 0));
    while (step.inputs.length && !step.inputs[step.inputs.length - 1] && step.inputs.length > (needed === 2 ? 2 : 0)) { step.inputs.pop(); }
}

const OP_TEXT: Record<string, string> = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤', 'contains': 'contains', 'starts with': 'starts with', 'ends with': 'ends with', 'in': 'in', 'between': 'between', 'is null': 'is NULL', 'is not null': 'is not NULL' };

/** One line describing what a step does, shown on its box */
function summary(step: Step): string {
    switch (step.type) {
        case 'source': return step.file ? `${step.file}${step.table ? ` › ${step.table}` : step.sheet ? ` › ${step.sheet}` : ''}` : 'No file yet';
        case 'filter': return step.conditions.map(c => `${c.column || '?'} ${OP_TEXT[c.op]}${c.op.includes('null') ? '' : ` ${c.value ?? ''}${c.op === 'between' ? ` and ${c.value2 ?? ''}` : ''}`}`).join(step.match === 'any' ? ' or ' : ' and ') || 'No conditions';
        case 'sort': return step.keys.map(k => `${k.column || '?'} ${k.descending ? '↓' : '↑'}`).join(', ');
        case 'limit': return `First ${formatCount(step.rows)} rows`;
        case 'dedupe': return step.columns.length ? `One row per ${step.columns.join(', ')}` : 'Whole rows';
        case 'sample': return step.unit === 'percent' ? `${step.amount}% of rows` : `${formatCount(step.amount)} rows`;
        case 'select': return step.columns.length ? step.columns.map(c => c.as ? `${c.column} → ${c.as}` : c.column).join(', ') : 'No columns chosen';
        case 'formula': return `${step.name} = ${step.expression || '?'}`;
        case 'cast': return `${step.column || '?'} as ${step.to}`;
        case 'join': return `${step.kind} · ${step.on.map(k => `${k.left || '?'} = ${k.right || '?'}`).join(', ')}`;
        case 'union': return 'Match columns by name';
        case 'group': return `${step.by.length ? `by ${step.by.join(', ')}` : 'all rows'} · ${step.aggregates.map(a => `${a.fn}${a.column ? `(${a.column})` : ''}`).join(', ')}`;
        case 'pivot': return `${step.on || '?'} values as columns · ${step.fn}${step.value ? `(${step.value})` : ''}`;
        case 'unpivot': return `${step.columns.length} columns into ${step.name}, ${step.value}`;
        case 'window': return `${step.as} = ${step.fn}${step.column ? ` of ${step.column}` : ''}`;
        case 'sql': return step.text.replace(/\s+/g, ' ').slice(0, 80);
        case 'table': return 'Show the result';
        case 'chart': return `${step.chart.type === 'auto' ? 'Automatic' : step.chart.type} chart`;
        case 'export': return step.file;
    }
}

new FlowApp(document.getElementById('app')!);
