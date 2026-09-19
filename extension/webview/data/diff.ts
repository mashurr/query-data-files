// Compares the file with an earlier git version: rows added, removed and changed,
// matched on a key column. DuckDB does the matching; the grid marks the changes.

import { Column } from '../../src/shared/protocol';
import { formatCount, h } from '../shared/dom';
import { engine } from '../shared/rpc';
import { ident } from '../shared/sqltext';
import { decode, formatValue } from '../shared/values';
import { Grid, PAGE_ROWS } from './grid';
import { resultTable } from './profile';

const HIDDEN = 3;
const WHOLE_ROWS = '';
type Change = 'all' | 'added' | 'removed' | 'changed';

interface Versions {
    label: string;
    oldSource: string;
    oldColumns: Column[];
    newSource: string;
    newColumns: Column[];
}

/** Columns that look like row identifiers, most likely first */
function keyCandidates(columns: Column[]): string[] {
    const score = (name: string) => /^id$/i.test(name) ? 0 : /(_id|_key|^key|uuid|_code)$/i.test(name) ? 1 : /id/i.test(name) ? 2 : 3;
    return columns.map(c => c.name).filter(n => score(n) < 3).sort((a, b) => score(a) - score(b)).slice(0, 6);
}

export class DiffView {
    private readonly bar = h('div', { className: 'diff-bar' });
    private readonly notes = h('div', { className: 'diff-notes' });
    private readonly gridHost = h('div', { className: 'content' });
    private readonly grid: Grid;
    private versions: Versions | undefined;
    private key = WHOLE_ROWS;
    private filter: Change = 'all';
    private counts: Record<string, number> = {};
    private token = 0;
    /** The stored comparison, filtered for display by the pills */
    private table: string | undefined;

    constructor(host: HTMLElement, private readonly stop: () => void, private readonly problem: (text: string) => void) {
        host.classList.add('diff');
        host.append(this.bar, this.notes, this.gridHost);
        this.grid = new Grid(this.gridHost, { headerClick: () => undefined, headerMenu: () => undefined, cellMenu: () => undefined, copyCell: () => undefined });
        this.grid.setProfilesVisible(false);
    }

    get active(): boolean { return !!this.versions; }

    async start(versions: Versions) {
        this.versions = versions;
        this.filter = 'all';
        const common = versions.newColumns.filter(c => versions.oldColumns.some(o => o.name === c.name));
        this.key = await this.findKey(common);
        await this.run();
    }

    /** The current file changed on disk: compare again */
    async refresh(newSource: string, newColumns: Column[]) {
        if (!this.versions) { return; }
        this.versions = { ...this.versions, newSource, newColumns };
        await this.run();
    }

    clear() {
        this.versions = undefined;
        this.grid.clear();
    }

    /** The first likely key column that's unique in both versions */
    private async findKey(common: Column[]): Promise<string> {
        const v = this.versions!;
        const candidates = keyCandidates(common);
        if (!candidates.length) { return WHOLE_ROWS; }
        const checks = candidates.map((c, i) => `count(DISTINCT ${ident(c)}) = count(*) AND count(${ident(c)}) = count(*) AS u${i}`).join(', ');
        const [a, b] = await Promise.all([
            engine('diff', 'rows', { sql: `SELECT ${checks} FROM ${v.oldSource}`, limit: 1 }),
            engine('diff', 'rows', { sql: `SELECT ${checks} FROM ${v.newSource}`, limit: 1 }),
        ]);
        if (!a.ok || !b.ok) { return WHOLE_ROWS; }
        const da = decode(a.body), db = decode(b.body);
        const index = candidates.findIndex((_, i) => da.columns[i]?.[0] === true && db.columns[i]?.[0] === true);
        return index < 0 ? WHOLE_ROWS : candidates[index];
    }

    private sql(): string {
        const v = this.versions!;
        const oldNames = new Set(v.oldColumns.map(c => c.name));
        const newNames = new Set(v.newColumns.map(c => c.name));
        const common = v.newColumns.filter(c => oldNames.has(c.name)).map(c => c.name);
        const q = ident;
        if (this.key === WHOLE_ROWS) {
            const cols = common.map(q).join(', ');
            return `WITH a AS (SELECT ${cols} FROM ${v.oldSource}), b AS (SELECT ${cols} FROM ${v.newSource})
SELECT 'removed' AS "__change", []::VARCHAR[] AS "__changed", NULL::VARCHAR AS "__before", * FROM (SELECT * FROM a EXCEPT ALL SELECT * FROM b)
UNION ALL
SELECT 'added', []::VARCHAR[], NULL::VARCHAR, * FROM (SELECT * FROM b EXCEPT ALL SELECT * FROM a)`;
        }
        const k = q(this.key);
        const compared = common.filter(c => c !== this.key);
        const changed = compared.length ? `list_filter([${compared.map(c => `CASE WHEN a.${q(c)} IS DISTINCT FROM b.${q(c)} THEN ${literalName(c)} END`).join(', ')}], x -> x IS NOT NULL)` : '[]::VARCHAR[]';
        const before = compared.length ? `struct_pack(${compared.map(c => `${q(c)} := a.${q(c)}`).join(', ')})` : 'NULL::VARCHAR';
        const shown = [
            ...v.newColumns.map(c => oldNames.has(c.name) ? `coalesce(b.${q(c.name)}, a.${q(c.name)}) AS ${q(c.name)}` : `b.${q(c.name)} AS ${q(c.name)}`),
            ...v.oldColumns.filter(c => !newNames.has(c.name)).map(c => `a.${q(c.name)} AS ${q(c.name)}`),
        ];
        const differs = compared.length ? compared.map(c => `a.${q(c)} IS DISTINCT FROM b.${q(c)}`).join(' OR ') : 'false';
        return `WITH a AS (SELECT * FROM ${v.oldSource}), b AS (SELECT * FROM ${v.newSource})
SELECT CASE WHEN a.${k} IS NULL THEN 'added' WHEN b.${k} IS NULL THEN 'removed' ELSE 'changed' END AS "__change",
    ${changed} AS "__changed",
    ${before} AS "__before",
    ${shown.join(',\n    ')}
FROM a FULL OUTER JOIN b ON a.${k} = b.${k}
WHERE a.${k} IS NULL OR b.${k} IS NULL OR ${differs}
ORDER BY coalesce(b.${k}, a.${k})`;
    }

    private async run() {
        const token = ++this.token;
        const v = this.versions!;
        this.renderBar(true);
        const reply = await engine('diff', 'query', { sql: this.sql(), name: 'diff', user: false });
        if (token !== this.token) { return; }
        if (!reply.ok) {
            this.problem(`Comparing failed: ${reply.error.message}`);
            return;
        }
        const table = resultTable(String(reply.result.name));
        this.table = table;
        const counts = await engine('diff', 'rows', { sql: `SELECT "__change", count(*) FROM ${table} GROUP BY 1` });
        const newRows = await engine('diff', 'rows', { sql: `SELECT count(*) FROM ${v.newSource}`, limit: 1 });
        if (token !== this.token) { return; }
        this.counts = {};
        if (counts.ok) {
            const d = decode(counts.body);
            for (let i = 0; i < d.rows; i++) { this.counts[String(d.columns[0][i])] = Number(d.columns[1][i]); }
        }
        const total = newRows.ok ? Number(decode(newRows.body).columns[0][0]) : 0;
        this.counts.unchanged = Math.max(0, total - (this.counts.added ?? 0) - (this.counts.changed ?? 0));
        this.renderBar(false);
        this.renderNotes();
        await this.show(table);
    }

    /** Shows the stored comparison, filtered to one kind of change */
    private async show(table: string) {
        const token = this.token;
        const filtered = this.filter === 'all' ? `SELECT * FROM ${table}` : `SELECT * FROM ${table} WHERE "__change" = '${this.filter}'`;
        const reply = await engine('diff', 'query', { sql: filtered, name: 'diff_view', user: false, pageSize: PAGE_ROWS });
        if (token !== this.token || !reply.ok) { return; }
        const first = decode(reply.body);
        const columns = (reply.result.columns as Column[]);
        const beforeType = first.types[2];
        this.grid.setData({
            columns, types: first.types, rows: Number(reply.result.rows), first, hidden: HIDDEN, wide: true,
            fetch: async offset => {
                const page = await engine('diff', 'page', { name: 'diff_view', offset, limit: PAGE_ROWS });
                return page.ok ? decode(page.body) : undefined;
            },
            decorate: (row, cells, value) => {
                const change = String(value(0));
                row.classList.add(`diff-${change}`);
                const marker = row.querySelector('.cell.number');
                if (marker) { marker.textContent = change === 'added' ? '+' : change === 'removed' ? '−' : '~'; }
                if (change !== 'changed') { return; }
                const names = Array.from((value(1) ?? []) as ArrayLike<string>);
                const before = value(2) as Record<string, unknown> | null;
                const fields = 'children' in beforeType ? beforeType.children : [];
                for (const [index, cell] of cells) {
                    const name = columns[index]?.name;
                    if (!name || !names.includes(name)) { continue; }
                    const field = fields.find(f => f.name === name);
                    const old = before && field ? formatValue(before[name], field.type) : '';
                    cell.classList.add('diff-cell');
                    cell.prepend(h('span', { className: 'old', text: old }), ' ');
                    cell.title = `Was ${old}, now ${cell.textContent?.slice(old.length + 1) ?? ''}`;
                }
            },
        });
    }

    private renderBar(running: boolean) {
        const v = this.versions!;
        const common = v.newColumns.filter(c => v.oldColumns.some(o => o.name === c.name));
        const keySelect = h('select', { 'aria-label': 'Match rows on', title: 'Rows with the same value here are the same row' });
        keySelect.append(h('option', { value: WHOLE_ROWS, text: 'Whole rows' }), ...common.map(c => h('option', { value: c.name, text: c.name })));
        keySelect.value = this.key;
        keySelect.addEventListener('change', () => { this.key = keySelect.value; this.filter = 'all'; void this.run(); });
        const pill = (change: Change, label: string, count?: number) => {
            const b = h('button', { className: `pill ${change}${this.filter === change ? ' on' : ''}`, text: count === undefined ? label : `${label} ${formatCount(count)}`, disabled: running });
            b.addEventListener('click', () => {
                this.filter = change;
                this.renderBar(false);
                if (this.table) { void this.show(this.table); }
            });
            return b;
        };
        const stop = h('button', { className: 'secondary', text: 'Stop Comparing' });
        stop.addEventListener('click', () => this.stop());
        this.bar.replaceChildren(
            h('span', { className: 'diff-title', text: `Compared with ${v.label}` }),
            h('label', {}, 'Match rows on ', keySelect),
            ...(running ? [h('span', { className: 'meta', text: 'Comparing…' })] : [
                pill('all', 'All changes'),
                pill('added', '+', this.counts.added ?? 0),
                pill('removed', '−', this.counts.removed ?? 0),
                ...(this.key ? [pill('changed', '~', this.counts.changed ?? 0)] : []),
                h('span', { className: 'meta', text: this.key ? `${formatCount(this.counts.unchanged ?? 0)} unchanged` : 'Whole rows: a changed row shows as removed and added' }),
            ]),
            h('span', { className: 'spacer' }),
            stop,
        );
    }

    private renderNotes() {
        const v = this.versions!;
        const oldNames = new Set(v.oldColumns.map(c => c.name));
        const newNames = new Set(v.newColumns.map(c => c.name));
        const added = v.newColumns.filter(c => !oldNames.has(c.name)).map(c => c.name);
        const removed = v.oldColumns.filter(c => !newNames.has(c.name)).map(c => c.name);
        const retyped = v.newColumns.filter(c => v.oldColumns.some(o => o.name === c.name && o.type !== c.type)).map(c => `${c.name} (${v.oldColumns.find(o => o.name === c.name)!.type} → ${c.type})`);
        const parts = [
            added.length ? `New columns: ${added.join(', ')}` : '',
            removed.length ? `Removed columns: ${removed.join(', ')}` : '',
            retyped.length ? `Changed types: ${retyped.join(', ')}` : '',
        ].filter(Boolean);
        this.notes.textContent = parts.join(' · ');
        this.notes.hidden = !parts.length;
    }
}

function literalName(name: string): string {
    return `'${name.replace(/'/g, '\'\'')}'`;
}
