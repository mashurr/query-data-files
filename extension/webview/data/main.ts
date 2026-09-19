// The table view: a SQL bar over a virtual grid. Clicks in the grid (sort, filter,
// hide) become SQL in the bar, so the query on screen is always the one that ran.

import { Column, HostMessage, OpenedFile, QueryResult } from '../../src/shared/protocol';
import { formatCount, formatMs, h } from '../shared/dom';
import { showMenu } from '../shared/menu';
import { cancel, engine, loadState, onHostMessage, post, saveState } from '../shared/rpc';
import { trimStatement, valueLiteral } from '../shared/sqltext';
import { Decoded, decode, formatValue } from '../shared/values';
import { ChartSettings, ChartView, Pick } from './chart';
import { CellRef, Grid, PAGE_ROWS } from './grid';
import { Profile, computeProfiles, resultTable } from './profile';
import { Filter, Refinements, compose, describe, noRefinements } from './refine';

const DEFAULT_SQL = 'SELECT * FROM this';
const COPY_ROWS = 1000;

type View = 'table' | 'chart';

interface Saved {
    key: string;
    base: string;
    refine: Refinements;
    view?: View;
    chart?: ChartSettings;
}

interface Shown {
    result: QueryResult;
    types: Decoded['types'];
}

class App {
    private kind: 'file' | 'sql' = 'file';
    private key = '';
    private file: OpenedFile | undefined;
    private base = DEFAULT_SQL;
    private refine: Refinements = noRefinements();
    private shown: Shown | undefined;
    private running = false;
    private token = 0;
    private timer = 0;
    private view: View = 'table';
    private chartSettings: ChartSettings = { type: 'auto' };
    private profiles: (Profile | undefined)[] = [];

    private readonly title = h('span', { className: 'title' });
    private readonly picker = h('select', { className: 'picker', 'aria-label': 'Table' });
    private readonly meta = h('span', { className: 'meta' });
    private readonly exportButton = h('button', { className: 'secondary', text: 'Export ▾', title: 'Save or copy the result' });
    private readonly flowButton = h('button', { className: 'secondary', text: 'Open in Query Builder', title: 'Start a query flow that reads this file' });
    private readonly sqlBox = h('textarea', { className: 'sql', spellcheck: 'false', 'aria-label': 'SQL query', rows: 1 });
    private readonly runButton = h('button', { className: 'primary', text: 'Run', title: 'Run the query (Ctrl+Enter)' });
    private readonly status = h('span', { className: 'status', role: 'status', 'aria-live': 'polite' });
    private readonly chips = h('div', { className: 'chips' });
    private readonly message = h('div', { className: 'message', hidden: true });
    private readonly tabs = h('div', { className: 'tabs', role: 'tablist', 'aria-label': 'View' });
    private readonly gridHost = h('div', { className: 'content', role: 'tabpanel' });
    private readonly chartHost = h('div', { className: 'content', role: 'tabpanel', hidden: true });
    private readonly grid: Grid;
    private readonly chart: ChartView;

    constructor(root: HTMLElement) {
        root.append(
            h('div', { className: 'toolbar' }, this.title, this.picker, this.meta, h('span', { className: 'spacer' }), this.flowButton, this.exportButton),
            h('div', { className: 'sqlbar' }, this.sqlBox, h('div', { className: 'run' }, this.runButton, this.status)),
            this.chips,
            this.message,
            this.tabs,
            this.gridHost,
            this.chartHost,
        );
        this.chart = new ChartView(this.chartHost, settings => this.setChart(settings), pick => this.pick(pick));
        this.renderTabs();
        this.picker.hidden = true;
        this.grid = new Grid(this.gridHost, {
            headerClick: col => this.cycleSort(col),
            headerMenu: (col, x, y) => this.headerMenu(col, x, y),
            cellMenu: (cell, x, y) => this.cellMenu(cell, x, y),
            copyCell: cell => this.copyCell(cell),
        });
        this.runButton.addEventListener('click', () => this.running ? this.stop() : this.runTyped());
        this.sqlBox.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.runTyped(); }
        });
        this.sqlBox.addEventListener('input', () => this.fitSqlBox());
        this.picker.addEventListener('change', () => {
            const value = this.picker.value;
            post(this.file?.format === 'xlsx' ? { type: 'openTable', sheet: value } : { type: 'openTable', table: value });
        });
        this.exportButton.addEventListener('click', e => this.exportMenu(e.currentTarget as HTMLElement));
        this.flowButton.addEventListener('click', () => post({ type: 'newFlow' }));
        onHostMessage(m => this.receive(m));
        post({ type: 'ready' });
    }

    private receive(m: HostMessage) {
        switch (m.type) {
            case 'init': {
                this.kind = m.kind;
                this.flowButton.hidden = m.kind !== 'file';
                this.title.textContent = m.title;
                this.key = m.file?.path ?? m.title;
                this.setFile(m.file);
                const saved = loadState<Saved>();
                if (saved && saved.key === this.key && m.kind === 'file') {
                    this.base = saved.base;
                    this.refine = saved.refine;
                    this.view = saved.view ?? 'table';
                    this.chartSettings = saved.chart ?? { type: 'auto' };
                    this.renderTabs();
                } else {
                    this.base = m.sql;
                    this.refine = noRefinements();
                }
                if (m.problem) {
                    this.showProblem(m.problem);
                    this.sqlBox.value = compose(this.base, this.refine);
                    this.fitSqlBox();
                } else {
                    void this.run();
                }
                break;
            }
            case 'opened': {
                const tableChanged = m.file?.table !== this.file?.table || m.file?.sheet !== this.file?.sheet;
                this.setFile(m.file);
                if (m.problem) {
                    this.showProblem(m.problem);
                } else if (tableChanged) {
                    this.base = DEFAULT_SQL;
                    this.refine = noRefinements();
                    void this.run();
                }
                break;
            }
            case 'reset':
                void this.run();
                break;
            case 'run':
                this.base = m.sql;
                this.refine = noRefinements();
                void this.run();
                break;
        }
    }

    private setFile(file: OpenedFile | undefined) {
        this.file = file;
        const options = file?.format === 'xlsx' ? file.sheets : file?.tables;
        const current = file?.format === 'xlsx' ? file.sheet : file?.table;
        this.picker.hidden = !options || options.length < 2;
        this.picker.setAttribute('aria-label', file?.format === 'xlsx' ? 'Sheet' : 'Table');
        this.picker.replaceChildren(...(options ?? []).map(o => h('option', { value: o, text: o })));
        if (current) { this.picker.value = current; }
        if (file && file.source === null && !file.tables?.length && file.format !== 'xlsx' && (file.format === 'sqlite' || file.format === 'duckdb')) {
            this.showProblem('This database has no tables.');
        }
    }

    private showProblem(text: string) {
        this.message.hidden = false;
        this.message.className = 'message error';
        this.message.replaceChildren(h('pre', { text }));
    }

    private hideMessage() {
        this.message.hidden = true;
        this.message.replaceChildren();
    }

    private fitSqlBox() {
        const lines = this.sqlBox.value.split('\n').length;
        this.sqlBox.rows = Math.min(12, Math.max(1, lines));
    }

    private save() {
        saveState({ key: this.key, base: this.base, refine: this.refine, view: this.view, chart: this.chartSettings } satisfies Saved);
    }

    /** Runs whatever is in the SQL box; it becomes the new base query */
    private runTyped() {
        const typed = this.sqlBox.value;
        if (!typed.trim()) { return; }
        if (typed !== compose(this.base, this.refine)) {
            this.base = typed;
            this.refine = noRefinements();
        }
        void this.run();
    }

    private stop() {
        cancel('main', 'profile');
    }

    private setRunning(running: boolean, started = 0) {
        this.running = running;
        this.runButton.textContent = running ? 'Cancel' : 'Run';
        this.runButton.title = running ? 'Stop the query' : 'Run the query (Ctrl+Enter)';
        this.runButton.className = running ? 'secondary' : 'primary';
        clearInterval(this.timer);
        if (running) {
            const tick = () => { this.status.textContent = `Running… ${formatMs(performance.now() - started)}`; };
            tick();
            this.timer = window.setInterval(tick, 200);
        }
    }

    private renderChips() {
        const chips: HTMLElement[] = [];
        const chip = (label: string, remove: () => void, title: string) => {
            const button = h('button', { className: 'chip', title, text: `${label} ×` });
            button.addEventListener('click', remove);
            chips.push(button);
        };
        this.refine.filters.forEach((f, i) => chip(describe(f), () => {
            this.refine.filters.splice(i, 1);
            void this.run();
        }, 'Remove this filter'));
        if (this.refine.sort) {
            chip(`Sorted by ${this.refine.sort.column} ${this.refine.sort.descending ? '↓' : '↑'}`, () => {
                this.refine.sort = undefined;
                void this.run();
            }, 'Remove the sort');
        }
        if (this.refine.hidden.length) {
            const n = this.refine.hidden.length;
            chip(`${n} hidden column${n === 1 ? '' : 's'}`, () => {
                this.refine.hidden = [];
                void this.run();
            }, `Show ${this.refine.hidden.join(', ')}`);
        }
        if (chips.length > 1) {
            const clear = h('button', { className: 'link', text: 'Clear all' });
            clear.addEventListener('click', () => { this.refine = noRefinements(); void this.run(); });
            chips.push(clear);
        }
        this.chips.replaceChildren(...chips);
        this.chips.hidden = !chips.length;
    }

    /** The first rows come from a quick LIMIT query while the full result is stored */
    private canPeek(): boolean {
        return this.kind === 'file' && !this.refine.sort && /^select\s+\*\s+from\s+this\b/i.test(trimStatement(this.base));
    }

    async run() {
        const sql = compose(this.base, this.refine);
        const token = ++this.token;
        if (this.running) { cancel('main', 'profile'); }
        this.sqlBox.value = sql;
        this.fitSqlBox();
        this.renderChips();
        this.save();
        this.hideMessage();
        const started = performance.now();
        this.setRunning(true, started);
        let peeked = false;

        if (this.canPeek()) {
            const peek = await engine('main', 'rows', { sql: `SELECT * FROM (\n${trimStatement(sql)}\n) LIMIT ${PAGE_ROWS}`, limit: PAGE_ROWS });
            if (token !== this.token) { return; }
            if (peek.ok) {
                const decoded = decode(peek.body);
                const columns = peek.result.columns as Column[];
                const sameColumns = this.shown?.result.columns.map(c => c.name).join('\n') === columns.map(c => c.name).join('\n');
                this.grid.setData({ columns, types: decoded.types, rows: decoded.rows, first: decoded }, sameColumns);
                this.meta.textContent = `${columns.length} columns · counting rows…`;
                peeked = true;
            }
        }

        const reply = await engine('main', 'query', { sql, name: 'result', pageSize: PAGE_ROWS });
        if (token !== this.token) { return; }
        this.setRunning(false);
        if (!reply.ok) {
            if (reply.error.kind === 'cancelled') {
                this.status.textContent = 'Cancelled';
            } else {
                this.status.textContent = '';
                this.showProblem(reply.error.message);
            }
            if (!peeked) { this.grid.clear(); this.shown = undefined; }
            this.meta.textContent = '';
            return;
        }
        const result = reply.result as unknown as QueryResult;
        const decoded = decode(reply.body);
        const sameColumns = peeked || this.shown?.result.columns.map(c => c.name).join('\n') === result.columns.map(c => c.name).join('\n');
        this.shown = { result, types: decoded.types };
        this.grid.setData({
            columns: result.columns,
            types: decoded.types,
            rows: result.direct ? decoded.rows : result.rows,
            first: decoded,
            fetch: result.direct ? undefined : offset => this.fetchPage(offset),
        }, sameColumns);
        this.grid.setSort(this.refine.sort ? result.columns.findIndex(c => c.name === this.refine.sort!.column) : undefined, !!this.refine.sort?.descending);
        this.meta.textContent = `${formatCount(result.rows)} row${result.rows === 1 ? '' : 's'} · ${result.columns.length} column${result.columns.length === 1 ? '' : 's'}`;
        this.status.textContent = `${formatMs(result.ms)}${result.truncated ? ` · first ${formatCount(decoded.rows)} rows shown` : ''}`;
        this.exportButton.disabled = result.direct;

        this.profiles = [];
        if (!sameColumns) { this.chartSettings = { type: 'auto' }; }
        if (this.view === 'chart') { this.showChart(); }
        if (!result.direct && result.rows > 0 && result.name) {
            this.grid.setProfiles([]);
            const profiles = await computeProfiles(resultTable(result.name), result.columns, result.rows);
            if (token === this.token && profiles) {
                this.profiles = profiles;
                this.grid.setProfiles(profiles);
            }
        } else {
            this.grid.setProfiles([]);
        }
    }

    private renderTabs() {
        const tab = (view: View, label: string) => {
            const button = h('button', { role: 'tab', 'aria-selected': String(this.view === view), className: this.view === view ? 'active' : '', text: label });
            button.addEventListener('click', () => this.setView(view));
            return button;
        };
        this.tabs.replaceChildren(tab('table', 'Table'), tab('chart', 'Chart'));
        this.gridHost.hidden = this.view !== 'table';
        this.chartHost.hidden = this.view !== 'chart';
    }

    private setView(view: View) {
        if (view === this.view) { return; }
        this.view = view;
        this.renderTabs();
        this.save();
        if (view === 'chart') { this.showChart(); }
    }

    private setChart(settings: ChartSettings) {
        this.chartSettings = settings;
        this.save();
        this.showChart();
    }

    private showChart() {
        const shown = this.shown;
        if (!shown) { return; }
        cancel('chart');
        const table = shown.result.direct || !shown.result.name ? null : resultTable(shown.result.name);
        void this.chart.show(this.chartSettings, shown.result.columns, this.profiles, table, shown.result.rows);
    }

    /** A clicked bar or point: show its rows in the table */
    private pick(pick: Pick) {
        this.refine.filters.push({ column: '', op: 'sql', value: pick.condition, label: pick.label });
        this.view = 'table';
        this.renderTabs();
        void this.run();
    }

    private async fetchPage(offset: number): Promise<Decoded | undefined> {
        const reply = await engine('page', 'page', { name: 'result', offset, limit: PAGE_ROWS });
        return reply.ok ? decode(reply.body) : undefined;
    }

    private columnName(index: number): string | undefined {
        return this.shown?.result.columns[index]?.name;
    }

    private cycleSort(index: number) {
        const column = this.columnName(index);
        if (!column) { return; }
        const current = this.refine.sort?.column === column ? this.refine.sort : undefined;
        this.refine.sort = !current ? { column, descending: false } : !current.descending ? { column, descending: true } : undefined;
        void this.run();
    }

    private addFilter(filter: Filter) {
        this.refine.filters = this.refine.filters.filter(f => !(f.column === filter.column && f.op === filter.op && f.value === filter.value));
        this.refine.filters.push(filter);
        void this.run();
    }

    private headerMenu(index: number, x: number, y: number) {
        const column = this.columnName(index);
        if (!column) { return; }
        const sorted = this.refine.sort?.column === column;
        showMenu(x, y, [
            { label: 'Sort Ascending', run: () => { this.refine.sort = { column, descending: false }; void this.run(); } },
            { label: 'Sort Descending', run: () => { this.refine.sort = { column, descending: true }; void this.run(); } },
            { label: 'Remove Sort', disabled: !sorted, run: () => { this.refine.sort = undefined; void this.run(); } },
            'separator',
            { label: 'Only Rows Where It Is NULL', run: () => this.addFilter({ column, op: 'is null' }) },
            { label: 'Only Rows Where It Is Not NULL', run: () => this.addFilter({ column, op: 'is not null' }) },
            { label: 'Hide Column', disabled: (this.shown?.result.columns.length ?? 0) - 1 <= 0, run: () => {
                this.refine.hidden.push(column);
                if (this.refine.sort?.column === column) { this.refine.sort = undefined; }
                void this.run();
            } },
            'separator',
            { label: 'Copy Column Name', run: () => post({ type: 'copy', text: column, what: 'the column name' }) },
        ]);
    }

    private cellMenu(cell: CellRef, x: number, y: number) {
        const shown = this.shown;
        const column = this.columnName(cell.column);
        if (!shown || !column) { return; }
        const type = shown.types[cell.column];
        const lit = valueLiteral(cell.value, type, shown.result.columns[cell.column].type);
        const label = cell.value === null || cell.value === undefined ? 'NULL' : formatValue(cell.value, type);
        const short = label.length > 40 ? label.slice(0, 39) + '…' : label;
        const isNull = cell.value === null || cell.value === undefined;
        showMenu(x, y, [
            isNull
                ? { label: 'Only Rows Where It Is NULL', run: () => this.addFilter({ column, op: 'is null' }) }
                : { label: `Only Rows Where ${column} = ${short}`, disabled: !lit, run: () => this.addFilter({ column, op: '=', value: lit, label: short }) },
            isNull
                ? { label: 'Hide Rows Where It Is NULL', run: () => this.addFilter({ column, op: 'is not null' }) }
                : { label: `Hide Rows Where ${column} = ${short}`, disabled: !lit, run: () => this.addFilter({ column, op: '!=', value: lit, label: short }) },
            'separator',
            { label: 'Copy Value', run: () => this.copyCell(cell) },
            { label: 'Copy Row', run: () => void this.copyRow(cell.row) },
        ]);
    }

    private copyCell(cell: CellRef) {
        const type = this.shown?.types[cell.column];
        if (!type) { return; }
        post({ type: 'copy', text: cell.value === null || cell.value === undefined ? '' : formatValue(cell.value, type), what: 'the value' });
    }

    private async copyRow(row: number) {
        const shown = this.shown;
        if (!shown) { return; }
        const page = await this.rowsFrom(row - row % PAGE_ROWS, PAGE_ROWS);
        if (!page) { return; }
        const i = row % PAGE_ROWS;
        const text = shown.result.columns.map((c, col) => `${c.name}\t${formatValue(page.columns[col]?.[i], shown.types[col])}`).join('\n');
        post({ type: 'copy', text, what: 'the row' });
    }

    private async rowsFrom(offset: number, count: number): Promise<Decoded | undefined> {
        const shown = this.shown;
        if (!shown) { return undefined; }
        if (shown.result.direct) {
            return undefined;
        }
        const reply = await engine('page', 'page', { name: 'result', offset, limit: count });
        return reply.ok ? decode(reply.body) : undefined;
    }

    private exportMenu(anchor: HTMLElement) {
        const shown = this.shown;
        const rect = anchor.getBoundingClientRect();
        const rows = shown?.result.rows ?? 0;
        const exportAs = (format: 'csv' | 'parquet' | 'json' | 'xlsx') => post({ type: 'export', format, name: 'result', rows });
        const none = !shown || shown.result.direct;
        showMenu(rect.left, rect.bottom + 2, [
            { label: 'Save as CSV…', disabled: none, run: () => exportAs('csv') },
            { label: 'Save as Parquet…', disabled: none, run: () => exportAs('parquet') },
            { label: 'Save as JSON…', disabled: none, run: () => exportAs('json') },
            { label: 'Save as Excel Workbook…', disabled: none, run: () => exportAs('xlsx') },
            'separator',
            { label: `Copy as Markdown Table${rows > COPY_ROWS ? ` (first ${formatCount(COPY_ROWS)} rows)` : ''}`, disabled: none, run: () => void this.copyMarkdown() },
            { label: 'Copy SQL', run: () => post({ type: 'copy', text: this.sqlBox.value, what: 'the query' }) },
        ]);
    }

    private async copyMarkdown() {
        const shown = this.shown;
        if (!shown) { return; }
        const rows = await this.rowsFrom(0, COPY_ROWS);
        if (!rows) { return; }
        const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        const columns = shown.result.columns;
        const lines = [
            `| ${columns.map(c => cell(c.name)).join(' | ')} |`,
            `| ${columns.map(() => '---').join(' | ')} |`,
        ];
        for (let r = 0; r < rows.rows; r++) {
            lines.push(`| ${columns.map((_, c) => cell(formatValue(rows.columns[c][r], shown.types[c]))).join(' | ')} |`);
        }
        post({ type: 'copy', text: lines.join('\n') + '\n', what: `${formatCount(rows.rows)} rows as a Markdown table` });
    }
}

new App(document.getElementById('app')!);
