// The settings of the selected step. Column pickers list the input step's columns,
// so the choices are always columns that exist.

import { Column } from '../../src/shared/protocol';
import { Aggregate, ExportFormat, JoinKind, Op, STEPS, Step, WindowFunction, formatOfName } from '../../src/shared/flow';
import { h } from '../shared/dom';
import { kindOf } from '../data/profile';

export interface InspectorContext {
    step: Step;
    /** Columns of each input, in input order; undefined while unknown */
    inputs: (Column[] | undefined)[];
    inputNames: string[];
    error?: string;
    trusted: boolean;
    /** Tables or sheets of a database or workbook source */
    sourceChoices?: { kind: 'table' | 'sheet'; names: string[] } | { error: string };
    change(update: (step: Step) => void, options?: { typing?: boolean }): void;
    rename(id: string): string | undefined;
    remove(): void;
    pickFile(): void;
    runExport(): void;
}

const OPS: Op[] = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'starts with', 'ends with', 'in', 'between', 'is null', 'is not null'];
const OP_LABELS: Record<Op, string> = {
    '=': 'equals', '!=': 'does not equal', '>': 'is greater than', '>=': 'is at least', '<': 'is less than', '<=': 'is at most',
    'contains': 'contains', 'starts with': 'starts with', 'ends with': 'ends with', 'in': 'is one of', 'between': 'is between',
    'is null': 'is NULL', 'is not null': 'is not NULL',
};
const AGGREGATES: Aggregate[] = ['count', 'count distinct', 'sum', 'avg', 'min', 'max', 'median', 'first'];
const AGGREGATE_LABELS: Record<Aggregate, string> = {
    'count': 'Count', 'count distinct': 'Count distinct', 'sum': 'Sum', 'avg': 'Average', 'min': 'Minimum', 'max': 'Maximum', 'median': 'Median', 'first': 'First value',
};
const WINDOWS: WindowFunction[] = ['row number', 'rank', 'running sum', 'running count', 'previous value', 'next value', 'share of total'];
const TYPES = ['VARCHAR', 'BIGINT', 'DOUBLE', 'DECIMAL(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN'];
const CHECKLIST_FILTER = 12;

let fieldId = 0;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const id = `f${++fieldId}`;
    control.id = control.id || id;
    return h('div', { className: 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('div', { className: 'hint', text: hint }) : null);
}

function select(options: [string, string][], value: string, onChange: (v: string) => void, placeholder?: string): HTMLSelectElement {
    const el = h('select');
    if (placeholder !== undefined && !options.some(([v]) => v === value)) { el.append(h('option', { value: '', text: placeholder })); }
    if (value && !options.some(([v]) => v === value)) { el.append(h('option', { value, text: `${value} (missing)` })); }
    el.append(...options.map(([v, text]) => h('option', { value: v, text })));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

function columnSelect(columns: Column[] | undefined, value: string | undefined, onChange: (v: string) => void, filter?: (c: Column) => boolean, placeholder = 'Choose a column'): HTMLSelectElement {
    const list = (columns ?? []).filter(c => !filter || filter(c));
    return select(list.map(c => [c.name, `${c.name}  ·  ${c.type}`]), value ?? '', onChange, placeholder);
}

function text(value: string, onInput: (v: string) => void, attrs: Record<string, string> = {}): HTMLInputElement {
    const el = h('input', { type: 'text', value, spellcheck: 'false', ...attrs });
    el.addEventListener('input', () => onInput(el.value));
    return el;
}

function number(value: number, onInput: (v: number) => void, min = 0): HTMLInputElement {
    const el = h('input', { type: 'number', value: String(value), min: String(min) });
    el.addEventListener('input', () => { if (el.value !== '' && !Number.isNaN(Number(el.value))) { onInput(Number(el.value)); } });
    return el;
}

function checklist(columns: Column[] | undefined, chosen: string[], onChange: (names: string[]) => void): HTMLElement {
    const box = h('div', { className: 'checklist', role: 'group' });
    const list = h('div', { className: 'checks' });
    const all = columns ?? [];
    const draw = (query: string) => {
        const q = query.toLowerCase();
        list.replaceChildren(...all.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => {
            const input = h('input', { type: 'checkbox', checked: chosen.includes(c.name) });
            input.addEventListener('change', () => {
                const next = input.checked ? [...chosen, c.name] : chosen.filter(n => n !== c.name);
                // Keep the input's column order
                onChange(all.map(x => x.name).filter(n => next.includes(n)));
            });
            return h('label', {}, input, h('span', { text: c.name }), h('em', { text: c.type }));
        }));
    };
    if (all.length > CHECKLIST_FILTER) {
        const search = h('input', { type: 'search', placeholder: `Filter ${all.length.toLocaleString('en-US')} columns`, 'aria-label': 'Filter columns' });
        search.addEventListener('input', () => draw(search.value));
        box.append(search);
    }
    draw('');
    box.append(list);
    if (!all.length) { list.append(h('div', { className: 'hint', text: 'Columns appear once the input step works.' })); }
    return box;
}

function rows<T>(items: T[], render: (item: T, index: number) => HTMLElement[], add: () => void, remove: (index: number) => void, addLabel: string): HTMLElement {
    const box = h('div', { className: 'rows' });
    items.forEach((item, i) => {
        const removeButton = h('button', { className: 'icon', title: 'Remove', 'aria-label': 'Remove', text: '×' });
        removeButton.addEventListener('click', () => remove(i));
        box.append(h('div', { className: 'row-item' }, ...render(item, i), removeButton));
    });
    const addButton = h('button', { className: 'link', text: `+ ${addLabel}` });
    addButton.addEventListener('click', add);
    box.append(addButton);
    return box;
}

const isNumber = (c: Column) => kindOf(c.type) === 'number';

export function renderInspector(host: HTMLElement, ctx: InspectorContext) {
    const { step } = ctx;
    const info = STEPS[step.type];
    const input = ctx.inputs[0];
    const parts: (HTMLElement | null)[] = [];
    const idInput = text(step.id, () => undefined, { 'aria-label': 'Step name' });
    idInput.addEventListener('change', () => {
        const problem = ctx.rename(idInput.value.trim());
        if (problem) { idInput.value = step.id; idInput.title = problem; }
    });
    parts.push(h('div', { className: 'inspector-head' },
        h('span', { className: `kind ${info.group.replace(/\s+/g, '-').toLowerCase()}`, text: info.label }),
        idInput));
    parts.push(h('p', { className: 'hint', text: info.help }));
    if (info.inputs) {
        const names = ctx.inputNames.map((n, i) => n ? `${info.inputs === 2 ? (step.type === 'join' ? ['Left', 'Right'][i] : `Input ${i + 1}`) + ': ' : ''}${n}` : null).filter(Boolean);
        parts.push(h('p', { className: 'hint inputs', text: names.length ? names.join(' · ') : 'Not connected: drag from another step\'s right edge onto this one.' }));
    }
    const typing = { typing: true };

    switch (step.type) {
        case 'source': {
            const fileRow = h('div', { className: 'inline' },
                text(step.file, v => ctx.change(s => { if (s.type === 'source') { s.file = v; } }, typing), { placeholder: 'data/orders.csv or logs/*.csv', 'aria-label': 'File' }));
            const browse = h('button', { className: 'secondary', text: 'Browse…' });
            browse.addEventListener('click', () => ctx.pickFile());
            fileRow.append(browse);
            parts.push(field('File', fileRow, 'Relative to this flow file. Patterns like logs/*.csv read every matching file.'));
            const format = formatOfName(step.file);
            if (format === 'sqlite' || format === 'duckdb' || format === 'xlsx') {
                const choices = ctx.sourceChoices;
                const isSheet = format === 'xlsx';
                if (choices && 'error' in choices) {
                    parts.push(h('p', { className: 'problem', text: choices.error }));
                } else {
                    const names = choices?.names ?? [];
                    const value = (isSheet ? step.sheet : step.table) ?? '';
                    parts.push(field(isSheet ? 'Sheet' : 'Table', select(names.map(n => [n, n]), value, v => ctx.change(s => {
                        if (s.type === 'source') { if (isSheet) { s.sheet = v || undefined; } else { s.table = v || undefined; } }
                    }), isSheet ? 'First sheet' : 'Choose a table')));
                }
            }
            break;
        }
        case 'filter': {
            parts.push(field('Keep rows that match', select([['all', 'all conditions'], ['any', 'any condition']], step.match, v => ctx.change(s => { if (s.type === 'filter') { s.match = v as 'all' | 'any'; } }))));
            parts.push(rows(step.conditions, (c, i) => {
                const column = columnSelect(input, c.column, v => ctx.change(s => { if (s.type === 'filter') { s.conditions[i].column = v; } }));
                const op = select(OPS.map(o => [o, OP_LABELS[o]]), c.op, v => ctx.change(s => { if (s.type === 'filter') { s.conditions[i].op = v as Op; } }));
                const out: HTMLElement[] = [column, op];
                if (c.op !== 'is null' && c.op !== 'is not null') {
                    out.push(text(c.value ?? '', v => ctx.change(s => { if (s.type === 'filter') { s.conditions[i].value = v; } }, typing), { placeholder: c.op === 'in' ? 'a, b, c' : 'value', 'aria-label': 'Value' }));
                }
                if (c.op === 'between') {
                    out.push(text(c.value2 ?? '', v => ctx.change(s => { if (s.type === 'filter') { s.conditions[i].value2 = v; } }, typing), { placeholder: 'and', 'aria-label': 'Upper value' }));
                }
                return [h('div', { className: 'stack' }, ...out)];
            }, () => ctx.change(s => { if (s.type === 'filter') { s.conditions.push({ column: '', op: '=', value: '' }); } }),
            i => ctx.change(s => { if (s.type === 'filter') { s.conditions.splice(i, 1); } }), 'Add condition'));
            break;
        }
        case 'sort':
            parts.push(rows(step.keys, (k, i) => [
                columnSelect(input, k.column, v => ctx.change(s => { if (s.type === 'sort') { s.keys[i].column = v; } })),
                select([['asc', 'Smallest first'], ['desc', 'Largest first']], k.descending ? 'desc' : 'asc', v => ctx.change(s => { if (s.type === 'sort') { s.keys[i].descending = v === 'desc'; } })),
            ], () => ctx.change(s => { if (s.type === 'sort') { s.keys.push({ column: '', descending: false }); } }),
            i => ctx.change(s => { if (s.type === 'sort') { s.keys.splice(i, 1); } }), 'Add sort key'));
            break;
        case 'limit':
            parts.push(field('Rows to keep', number(step.rows, v => ctx.change(s => { if (s.type === 'limit') { s.rows = v; } }, typing))));
            break;
        case 'dedupe':
            parts.push(field('Match on these columns', checklist(input, step.columns, v => ctx.change(s => { if (s.type === 'dedupe') { s.columns = v; } })), 'None ticked: rows must match in every column.'));
            break;
        case 'sample':
            parts.push(field('Keep', h('div', { className: 'inline' },
                number(step.amount, v => ctx.change(s => { if (s.type === 'sample') { s.amount = v; } }, typing)),
                select([['percent', '% of rows'], ['rows', 'rows']], step.unit, v => ctx.change(s => { if (s.type === 'sample') { s.unit = v as 'percent' | 'rows'; } })))));
            break;
        case 'select': {
            parts.push(field('Columns to keep', checklist(input, step.columns.map(c => c.column), names => ctx.change(s => {
                if (s.type !== 'select') { return; }
                s.columns = names.map(n => s.columns.find(c => c.column === n) ?? { column: n });
            }))));
            if (step.columns.length) {
                parts.push(h('div', { className: 'field' }, h('span', { className: 'label', text: 'Rename' }),
                    ...step.columns.map((c, i) => h('div', { className: 'inline rename' }, h('span', { text: c.column }), text(c.as ?? '', v => ctx.change(s => {
                        if (s.type === 'select') { s.columns[i].as = v || undefined; }
                    }, typing), { placeholder: 'same name', 'aria-label': `New name for ${c.column}` })))));
            }
            break;
        }
        case 'formula': {
            parts.push(field('New column', text(step.name, v => ctx.change(s => { if (s.type === 'formula') { s.name = v; } }, typing))));
            const area = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'amount * 1.2', 'aria-label': 'Expression' });
            area.value = step.expression;
            area.addEventListener('input', () => ctx.change(s => { if (s.type === 'formula') { s.expression = area.value; } }, typing));
            parts.push(field('SQL expression', area, 'Any DuckDB expression, e.g. round(amount * 1.2, 2), upper(name) or order_date + INTERVAL 30 DAY. A name that already exists is replaced.'));
            if (input?.length) {
                const chips = h('div', { className: 'column-chips' }, ...input.slice(0, 60).map(c => {
                    const chip = h('button', { className: 'chip-button', text: c.name, title: `Insert ${c.name}` });
                    chip.addEventListener('click', () => {
                        const name = /^[a-z_][a-z0-9_]*$/.test(c.name) ? c.name : `"${c.name.replace(/"/g, '""')}"`;
                        area.setRangeText(name, area.selectionStart, area.selectionEnd, 'end');
                        area.focus();
                        area.dispatchEvent(new Event('input'));
                    });
                    return chip;
                }));
                parts.push(chips);
            }
            break;
        }
        case 'cast':
            parts.push(field('Column', columnSelect(input, step.column, v => ctx.change(s => { if (s.type === 'cast') { s.column = v; } }))));
            parts.push(field('New type', select(TYPES.map(t => [t, t]), step.to, v => ctx.change(s => { if (s.type === 'cast') { s.to = v; } }))));
            break;
        case 'join': {
            parts.push(field('Keep', select([
                ['inner', 'Rows that match on both sides'], ['left', 'All left rows, matched where possible'], ['right', 'All right rows, matched where possible'],
                ['full', 'All rows from both sides'], ['semi', 'Left rows that have a match (no right columns)'], ['anti', 'Left rows with no match'],
            ], step.kind, v => ctx.change(s => { if (s.type === 'join') { s.kind = v as JoinKind; } }))));
            parts.push(h('div', { className: 'field' }, h('span', { className: 'label', text: 'Match rows where' }), rows(step.on, (k, i) => [
                columnSelect(ctx.inputs[0], k.left, v => ctx.change(s => { if (s.type === 'join') { s.on[i].left = v; } }), undefined, 'Left column'),
                h('span', { className: 'equals', text: '=' }),
                columnSelect(ctx.inputs[1], k.right, v => ctx.change(s => { if (s.type === 'join') { s.on[i].right = v; } }), undefined, 'Right column'),
            ], () => ctx.change(s => { if (s.type === 'join') { s.on.push({ left: '', right: '' }); } }),
            i => ctx.change(s => { if (s.type === 'join') { s.on.splice(i, 1); } }), 'Add key')));
            parts.push(h('p', { className: 'hint', text: 'Right-hand columns named like a left-hand one get a _right suffix.' }));
            break;
        }
        case 'union':
            parts.push(h('p', { className: 'hint', text: 'Columns are matched by name. A column missing on one side is NULL for its rows.' }));
            break;
        case 'group':
            parts.push(field('Group by', checklist(input, step.by, v => ctx.change(s => { if (s.type === 'group') { s.by = v; } })), 'None ticked: one row for the whole input.'));
            parts.push(h('div', { className: 'field' }, h('span', { className: 'label', text: 'Calculations' }), rows(step.aggregates, (g, i) => [
                select(AGGREGATES.map(a => [a, AGGREGATE_LABELS[a]]), g.fn, v => ctx.change(s => { if (s.type === 'group') { s.aggregates[i].fn = v as Aggregate; } })),
                columnSelect(input, g.column, v => ctx.change(s => { if (s.type === 'group') { s.aggregates[i].column = v || undefined; } }),
                    g.fn === 'count' || g.fn === 'count distinct' || g.fn === 'first' ? undefined : isNumber, g.fn === 'count' ? 'All rows' : 'Choose a column'),
                text(g.as, v => ctx.change(s => { if (s.type === 'group') { s.aggregates[i].as = v; } }, typing), { placeholder: 'name', 'aria-label': 'Result name' }),
            ], () => ctx.change(s => {
                if (s.type !== 'group') { return; }
                const measure = input?.find(isNumber);
                s.aggregates.push(measure ? { fn: 'sum', column: measure.name, as: `total_${measure.name}` } : { fn: 'count', as: `rows_${s.aggregates.length + 1}` });
            }), i => ctx.change(s => { if (s.type === 'group') { s.aggregates.splice(i, 1); } }), 'Add calculation')));
            break;
        case 'pivot':
            parts.push(field('Values become columns', columnSelect(input, step.on, v => ctx.change(s => { if (s.type === 'pivot') { s.on = v; } }))));
            parts.push(field('Each cell is the', h('div', { className: 'inline' },
                select(AGGREGATES.map(a => [a, AGGREGATE_LABELS[a]]), step.fn, v => ctx.change(s => { if (s.type === 'pivot') { s.fn = v as Aggregate; } })),
                columnSelect(input, step.value, v => ctx.change(s => { if (s.type === 'pivot') { s.value = v || undefined; } }), undefined, step.fn === 'count' ? 'of rows' : 'of column'))));
            parts.push(field('One row per', checklist(input, step.by, v => ctx.change(s => { if (s.type === 'pivot') { s.by = v; } })), 'None ticked: one row per combination of the other columns.'));
            break;
        case 'unpivot':
            parts.push(field('Columns to turn into rows', checklist(input, step.columns, v => ctx.change(s => { if (s.type === 'unpivot') { s.columns = v; } }))));
            parts.push(field('Name column', text(step.name, v => ctx.change(s => { if (s.type === 'unpivot') { s.name = v; } }, typing))));
            parts.push(field('Value column', text(step.value, v => ctx.change(s => { if (s.type === 'unpivot') { s.value = v; } }, typing))));
            break;
        case 'window': {
            parts.push(field('Calculate', select(WINDOWS.map(w => [w, w[0].toUpperCase() + w.slice(1)]), step.fn, v => ctx.change(s => { if (s.type === 'window') { s.fn = v as WindowFunction; } }))));
            if (!['row number', 'rank', 'running count'].includes(step.fn)) {
                parts.push(field('Of column', columnSelect(input, step.column, v => ctx.change(s => { if (s.type === 'window') { s.column = v; } }), step.fn === 'previous value' || step.fn === 'next value' ? undefined : isNumber)));
            }
            parts.push(field('Separately for each', checklist(input, step.partition, v => ctx.change(s => { if (s.type === 'window') { s.partition = v; } })), 'None ticked: across all rows.'));
            if (step.fn !== 'share of total') {
                parts.push(field('In order of', h('div', { className: 'inline' },
                    columnSelect(input, step.order, v => ctx.change(s => { if (s.type === 'window') { s.order = v || undefined; } }), undefined, 'No order'),
                    select([['asc', 'ascending'], ['desc', 'descending']], step.descending ? 'desc' : 'asc', v => ctx.change(s => { if (s.type === 'window') { s.descending = v === 'desc'; } })))));
            }
            parts.push(field('New column', text(step.as, v => ctx.change(s => { if (s.type === 'window') { s.as = v; } }, typing))));
            break;
        }
        case 'sql': {
            const area = h('textarea', { rows: 8, spellcheck: 'false', 'aria-label': 'SQL' });
            area.value = step.text;
            area.addEventListener('input', () => ctx.change(s => { if (s.type === 'sql') { s.text = area.value; } }, typing));
            parts.push(field('Query', area, 'Refer to the input step as input. The rest of the flow still becomes plain SQL around this.'));
            break;
        }
        case 'table':
            parts.push(h('p', { className: 'hint', text: 'Shows the input in the preview below. Copy as SQL or open it as a SQL file from the toolbar.' }));
            break;
        case 'chart':
            parts.push(h('p', { className: 'hint', text: 'Choose the chart type and columns above the chart in the preview. They are saved in the flow.' }));
            break;
        case 'export': {
            parts.push(field('File', text(step.file, v => ctx.change(s => { if (s.type === 'export') { s.file = v; } }, typing), { placeholder: 'result.parquet' }), 'Relative to this flow file.'));
            parts.push(field('Format', select([['parquet', 'Parquet'], ['csv', 'CSV'], ['json', 'JSON'], ['xlsx', 'Excel workbook']], step.format, v => ctx.change(s => {
                if (s.type !== 'export') { return; }
                s.format = v as ExportFormat;
                s.file = s.file.replace(/\.(parquet|csv|json|xlsx)$/i, '') + `.${v}`;
            }))));
            const run = h('button', { className: 'primary', text: 'Write File', disabled: !ctx.trusted || !!ctx.error });
            run.addEventListener('click', () => ctx.runExport());
            parts.push(h('div', { className: 'actions' }, run));
            parts.push(h('p', { className: 'hint', text: 'Also runs from a terminal: qdf-engine run <flow file> writes every Export step.' }));
            break;
        }
    }
    if (ctx.error) { parts.push(h('pre', { className: 'problem', text: ctx.error })); }
    const remove = h('button', { className: 'link danger', text: 'Delete step' });
    remove.addEventListener('click', () => ctx.remove());
    parts.push(h('div', { className: 'actions' }, remove));

    // Keep focus and cursor in the field being edited when the panel is redrawn
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const activeIndex = active && host.contains(active) ? [...host.querySelectorAll('input, textarea, select')].indexOf(active) : -1;
    const cursor = active && 'selectionStart' in active && active.type !== 'number' && active.type !== 'checkbox' ? [active.selectionStart, active.selectionEnd] : null;
    host.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    if (activeIndex >= 0) {
        const again = host.querySelectorAll('input, textarea, select')[activeIndex] as HTMLInputElement | undefined;
        again?.focus();
        if (again && cursor && 'setSelectionRange' in again && again.type !== 'number') {
            try { again.setSelectionRange(cursor[0], cursor[1]); } catch { /* not a text field */ }
        }
    }
}
