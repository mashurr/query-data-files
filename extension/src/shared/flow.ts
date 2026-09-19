// Query flows (.qflow.json): steps connected into a graph, compiled to one DuckDB query
// with a named WITH block per step. Shared by the extension and the builder webview.

import { Column } from './protocol';

export const FLOW_VERSION = 1;

export type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'starts with' | 'ends with' | 'in' | 'between' | 'is null' | 'is not null';
export type Aggregate = 'count' | 'count distinct' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'first';
export type WindowFunction = 'row number' | 'rank' | 'running sum' | 'running count' | 'previous value' | 'next value' | 'share of total';
export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti';
export type ExportFormat = 'csv' | 'parquet' | 'json' | 'xlsx';

export interface Condition { column: string; op: Op; value?: string; value2?: string }

export type StepBody =
    | { type: 'source'; file: string; table?: string; sheet?: string }
    | { type: 'filter'; conditions: Condition[]; match: 'all' | 'any' }
    | { type: 'sort'; keys: { column: string; descending: boolean }[] }
    | { type: 'limit'; rows: number }
    | { type: 'dedupe'; columns: string[] }
    | { type: 'sample'; amount: number; unit: 'percent' | 'rows' }
    | { type: 'select'; columns: { column: string; as?: string }[] }
    | { type: 'formula'; name: string; expression: string }
    | { type: 'cast'; column: string; to: string }
    | { type: 'join'; kind: JoinKind; on: { left: string; right: string }[] }
    | { type: 'union' }
    | { type: 'group'; by: string[]; aggregates: { fn: Aggregate; column?: string; as: string }[] }
    | { type: 'pivot'; on: string; fn: Aggregate; value?: string; by: string[] }
    | { type: 'unpivot'; columns: string[]; name: string; value: string }
    | { type: 'window'; fn: WindowFunction; column?: string; partition: string[]; order?: string; descending?: boolean; as: string }
    | { type: 'sql'; text: string }
    | { type: 'table' }
    | { type: 'chart'; chart: { type: string; x?: string; y?: string; aggregate?: string; split?: string } }
    | { type: 'export'; file: string; format: ExportFormat };

export type StepType = StepBody['type'];
export type Step = StepBody & { id: string; inputs: string[]; note?: string };

export interface FlowFile {
    version: number;
    steps: Step[];
    /** Canvas positions, kept apart so moving a box makes a small diff */
    layout: Record<string, [number, number]>;
    /** SQL for each output step, written on save so `qdf-engine run` needs no builder */
    outputs?: { step: string; kind: 'table' | 'chart' | 'export'; setup?: string[]; sql: string; file?: string }[];
}

export interface StepInfo {
    label: string;
    group: 'Sources' | 'Rows' | 'Columns' | 'Combine' | 'Reshape' | 'Escape hatch' | 'Outputs';
    inputs: number;
    output: boolean;
    help: string;
}

export const STEPS: Record<StepType, StepInfo> = {
    source: { label: 'Source', group: 'Sources', inputs: 0, output: true, help: 'A data file, a SQLite or DuckDB table, an Excel sheet, or a folder pattern like logs/*.csv' },
    filter: { label: 'Filter', group: 'Rows', inputs: 1, output: true, help: 'Keep the rows that match' },
    sort: { label: 'Sort', group: 'Rows', inputs: 1, output: true, help: 'Order the rows' },
    limit: { label: 'Limit', group: 'Rows', inputs: 1, output: true, help: 'Keep the first rows' },
    dedupe: { label: 'Remove duplicates', group: 'Rows', inputs: 1, output: true, help: 'Keep one row per value of the chosen columns' },
    sample: { label: 'Sample', group: 'Rows', inputs: 1, output: true, help: 'A random share of the rows (the same each run)' },
    select: { label: 'Select columns', group: 'Columns', inputs: 1, output: true, help: 'Keep, reorder and rename columns' },
    formula: { label: 'Formula', group: 'Columns', inputs: 1, output: true, help: 'A new column from a SQL expression' },
    cast: { label: 'Change type', group: 'Columns', inputs: 1, output: true, help: 'Convert a column; values that don\'t fit become NULL' },
    join: { label: 'Join', group: 'Combine', inputs: 2, output: true, help: 'Match rows of two inputs on key columns' },
    union: { label: 'Union', group: 'Combine', inputs: 2, output: true, help: 'Stack the rows of two inputs, matching columns by name' },
    group: { label: 'Group and aggregate', group: 'Reshape', inputs: 1, output: true, help: 'One row per group with totals, averages or counts' },
    pivot: { label: 'Pivot', group: 'Reshape', inputs: 1, output: true, help: 'Turn the values of one column into columns' },
    unpivot: { label: 'Unpivot', group: 'Reshape', inputs: 1, output: true, help: 'Turn columns into name and value rows' },
    window: { label: 'Window', group: 'Reshape', inputs: 1, output: true, help: 'Running totals, ranks and previous values' },
    sql: { label: 'SQL', group: 'Escape hatch', inputs: 1, output: true, help: 'Any SQL; the input is called input' },
    table: { label: 'Table', group: 'Outputs', inputs: 1, output: false, help: 'Show the result as a table' },
    chart: { label: 'Chart', group: 'Outputs', inputs: 1, output: false, help: 'Show the result as a chart' },
    export: { label: 'Export', group: 'Outputs', inputs: 1, output: false, help: 'Write the result to a file' },
};

export function defaultBody(type: StepType): StepBody {
    switch (type) {
        case 'source': return { type, file: '' };
        case 'filter': return { type, conditions: [{ column: '', op: '=', value: '' }], match: 'all' };
        case 'sort': return { type, keys: [{ column: '', descending: false }] };
        case 'limit': return { type, rows: 100 };
        case 'dedupe': return { type, columns: [] };
        case 'sample': return { type, amount: 10, unit: 'percent' };
        case 'select': return { type, columns: [] };
        case 'formula': return { type, name: 'new_column', expression: '' };
        case 'cast': return { type, column: '', to: 'DOUBLE' };
        case 'join': return { type, kind: 'inner', on: [{ left: '', right: '' }] };
        case 'union': return { type };
        case 'group': return { type, by: [], aggregates: [{ fn: 'count', as: 'rows' }] };
        case 'pivot': return { type, on: '', fn: 'sum', by: [] };
        case 'unpivot': return { type, columns: [], name: 'name', value: 'value' };
        case 'window': return { type, fn: 'row number', partition: [], as: 'row_number' };
        case 'sql': return { type, text: 'SELECT *\nFROM input' };
        case 'table': return { type };
        case 'chart': return { type, chart: { type: 'auto' } };
        case 'export': return { type, file: 'result.parquet', format: 'parquet' };
    }
}

// ---------- SQL ----------

export const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const lit = (text: string) => `'${text.replace(/'/g, '\'\'')}'`;

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;

/** Lines up to 8 MB with DuckDB's usual 32 MB buffer (see CSV_LIMITS in the engine) */
const CSV_LIMITS = 'max_line_size = 8388608, buffer_size = 33554432';

export type FileFormat = 'csv' | 'tsv' | 'parquet' | 'json' | 'xlsx' | 'sqlite' | 'duckdb';

export function formatOfName(file: string): FileFormat | undefined {
    const ext = /\.([a-z0-9]+)$/i.exec(file.replace(/\*+$/, ''))?.[1]?.toLowerCase();
    switch (ext) {
        case 'csv': return 'csv';
        case 'tsv': return 'tsv';
        case 'parquet': return 'parquet';
        case 'json': case 'jsonl': case 'ndjson': return 'json';
        case 'xlsx': return 'xlsx';
        case 'sqlite': case 'sqlite3': case 'db': return 'sqlite';
        case 'duckdb': return 'duckdb';
        default: return undefined;
    }
}

export interface CompileContext {
    /** Turns a path written in the flow (relative to the flow file) into the one DuckDB reads */
    path(file: string): string;
    /** Output columns of each step, when known; used to rename clashing join columns */
    columns(stepId: string): Column[] | undefined;
    /**
     * Replaces a source with an empty row set of its known columns, so working out a later
     * step's columns doesn't read any files. Undefined means read the source as usual.
     */
    stub?(source: Step & { type: 'source' }): string | undefined;
}

/** An empty row set with these columns and types */
export function emptyRows(columns: Column[]): string {
    if (!columns.length) { return 'SELECT 1 AS "empty" WHERE false'; }
    return `SELECT ${columns.map(c => `NULL::${c.type} AS ${q(c.name)}`).join(', ')} WHERE false`;
}

export class FlowError extends Error {
    constructor(readonly step: string, message: string) { super(message); }
}

export interface Compiled {
    /** ATTACH statements for DuckDB database sources, run before the query */
    setup: string[];
    sql: string;
}

function attachAlias(file: string): string {
    return `qdf_${file.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
}

function sourceSql(step: Step & { type: 'source' }, ctx: CompileContext, setup: string[]): string {
    if (!step.file) { throw new FlowError(step.id, 'Choose a file'); }
    const stub = ctx.stub?.(step);
    if (stub) { return stub; }
    const format = formatOfName(step.file);
    const path = lit(ctx.path(step.file));
    switch (format) {
        case 'csv': return `SELECT * FROM read_csv(${path}, ${CSV_LIMITS})`;
        case 'tsv': return `SELECT * FROM read_csv(${path}, delim = '\\t', ${CSV_LIMITS})`;
        case 'parquet': return `SELECT * FROM read_parquet(${path})`;
        case 'json': return `SELECT * FROM read_json(${path})`;
        case 'xlsx': return `SELECT * FROM read_xlsx(${path}${step.sheet ? `, sheet = ${lit(step.sheet)}` : ''})`;
        case 'sqlite':
            if (!step.table) { throw new FlowError(step.id, 'Choose a table'); }
            return `SELECT * FROM sqlite_scan(${path}, ${lit(step.table)})`;
        case 'duckdb': {
            if (!step.table) { throw new FlowError(step.id, 'Choose a table'); }
            const alias = attachAlias(step.file);
            const attach = `ATTACH IF NOT EXISTS ${path} AS ${q(alias)} (READ_ONLY)`;
            if (!setup.includes(attach)) { setup.push(attach); }
            const [schema, table] = step.table.includes('.') ? step.table.split('.', 2) : ['main', step.table];
            return `SELECT * FROM ${q(alias)}.${q(schema)}.${q(table)}`;
        }
        default:
            throw new FlowError(step.id, 'Query Data Files reads .csv, .tsv, .parquet, .json, .jsonl, .xlsx, .sqlite and .duckdb files');
    }
}

function valueFor(column: Column | undefined, value: string): string {
    const text = value.trim();
    if (column && NUMERIC.test(column.type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) { return text; }
    return lit(value);
}

function conditionSql(c: Condition, columns: Column[] | undefined): string {
    if (!c.column) { throw new Error('Choose a column for every condition'); }
    const col = q(c.column);
    const info = columns?.find(x => x.name === c.column);
    const value = c.value ?? '';
    switch (c.op) {
        case 'is null': return `${col} IS NULL`;
        case 'is not null': return `${col} IS NOT NULL`;
        case 'contains': return `${col}::VARCHAR ILIKE ${lit(`%${value}%`)}`;
        case 'starts with': return `starts_with(lower(${col}::VARCHAR), ${lit(value.toLowerCase())})`;
        case 'ends with': return `ends_with(lower(${col}::VARCHAR), ${lit(value.toLowerCase())})`;
        case 'in': {
            const items = value.split(',').map(v => v.trim()).filter(Boolean);
            if (!items.length) { throw new Error('List the values, separated by commas'); }
            return `${col} IN (${items.map(v => valueFor(info, v)).join(', ')})`;
        }
        case 'between': return `${col} BETWEEN ${valueFor(info, value)} AND ${valueFor(info, c.value2 ?? '')}`;
        case '!=': return `${col} IS DISTINCT FROM ${valueFor(info, value)}`;
        default: return `${col} ${c.op} ${valueFor(info, value)}`;
    }
}

function aggregateSql(fn: Aggregate, column: string | undefined): string {
    if (fn === 'count' && !column) { return 'count(*)'; }
    if (!column) { throw new Error(`Choose a column for ${fn}`); }
    const col = q(column);
    switch (fn) {
        case 'count': return `count(${col})`;
        case 'count distinct': return `count(DISTINCT ${col})`;
        case 'first': return `first(${col})`;
        default: return `${fn}(${col})`;
    }
}

/** `input` in the SQL step's text, outside strings and quoted names */
function replaceInput(text: string, name: string): string {
    return text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\binput\b/gi, m => /^input$/i.test(m) ? name : m);
}

function stepSql(step: Step, inputs: string[], ctx: CompileContext, setup: string[]): string {
    const [a, b] = inputs.map(q);
    const inCols = step.inputs[0] ? ctx.columns(step.inputs[0]) : undefined;
    switch (step.type) {
        case 'source': return sourceSql(step, ctx, setup);
        case 'filter': {
            if (!step.conditions.length) { return `SELECT * FROM ${a}`; }
            const joiner = step.match === 'any' ? ' OR ' : ' AND ';
            return `SELECT * FROM ${a} WHERE ${step.conditions.map(c => conditionSql(c, inCols)).join(joiner)}`;
        }
        case 'sort': {
            const keys = step.keys.filter(k => k.column);
            if (!keys.length) { throw new Error('Choose a column to sort by'); }
            return `SELECT * FROM ${a} ORDER BY ${keys.map(k => `${q(k.column)} ${k.descending ? 'DESC' : 'ASC'} NULLS LAST`).join(', ')}`;
        }
        case 'limit': return `SELECT * FROM ${a} LIMIT ${Math.max(0, Math.floor(step.rows))}`;
        case 'dedupe': return step.columns.length ? `SELECT DISTINCT ON (${step.columns.map(q).join(', ')}) * FROM ${a}` : `SELECT DISTINCT * FROM ${a}`;
        case 'sample': return step.unit === 'percent'
            ? `SELECT * FROM ${a} USING SAMPLE ${Math.min(100, Math.max(0, step.amount))} PERCENT (bernoulli, 42)`
            : `SELECT * FROM ${a} USING SAMPLE ${Math.max(0, Math.floor(step.amount))} ROWS (reservoir, 42)`;
        case 'select': {
            if (!step.columns.length) { throw new Error('Choose the columns to keep'); }
            return `SELECT ${step.columns.map(c => c.as && c.as !== c.column ? `${q(c.column)} AS ${q(c.as)}` : q(c.column)).join(', ')} FROM ${a}`;
        }
        case 'formula': {
            if (!step.name) { throw new Error('Name the new column'); }
            if (!step.expression.trim()) { throw new Error('Write the expression, e.g. amount * 1.2'); }
            const exists = inCols?.some(c => c.name === step.name);
            return exists
                ? `SELECT * REPLACE ((${step.expression}) AS ${q(step.name)}) FROM ${a}`
                : `SELECT *, (${step.expression}) AS ${q(step.name)} FROM ${a}`;
        }
        case 'cast':
            if (!step.column) { throw new Error('Choose a column'); }
            return `SELECT * REPLACE (TRY_CAST(${q(step.column)} AS ${step.to}) AS ${q(step.column)}) FROM ${a}`;
        case 'join': {
            const on = step.on.filter(k => k.left && k.right);
            if (!on.length) { throw new Error('Choose the columns to match'); }
            const condition = on.map(k => `l.${q(k.left)} = r.${q(k.right)}`).join(' AND ');
            if (step.kind === 'semi' || step.kind === 'anti') {
                return `SELECT l.* FROM ${a} l ${step.kind.toUpperCase()} JOIN ${b} r ON ${condition}`;
            }
            // Right-hand columns named like a left-hand one get a _right suffix; matching keys of the same name appear once
            const left = new Set((ctx.columns(step.inputs[0]) ?? []).map(c => c.name));
            const right = ctx.columns(step.inputs[1]) ?? [];
            const sameKeys = new Set(on.filter(k => k.left === k.right).map(k => k.right));
            const dropped = right.filter(c => left.has(c.name)).map(c => c.name);
            const renamed = dropped.filter(n => !sameKeys.has(n) || step.kind === 'right' || step.kind === 'full');
            const rightPart = dropped.length
                ? `r.* EXCLUDE (${dropped.map(q).join(', ')})${renamed.map(n => `, r.${q(n)} AS ${q(`${n}_right`)}`).join('')}`
                : 'r.*';
            return `SELECT l.*, ${rightPart} FROM ${a} l ${step.kind.toUpperCase()} JOIN ${b} r ON ${condition}`;
        }
        case 'union': return `SELECT * FROM ${a} UNION ALL BY NAME SELECT * FROM ${b}`;
        case 'group': {
            const parts = [...step.by.map(q), ...step.aggregates.map(g => `${aggregateSql(g.fn, g.column)} AS ${q(g.as || g.fn)}`)];
            if (!parts.length) { throw new Error('Choose columns to group by or add a calculation'); }
            return `SELECT ${parts.join(', ')} FROM ${a}${step.by.length ? ` GROUP BY ${step.by.map(q).join(', ')}` : ''}`;
        }
        case 'pivot': {
            if (!step.on) { throw new Error('Choose the column whose values become columns'); }
            return `PIVOT ${a} ON ${q(step.on)} USING ${aggregateSql(step.fn, step.value)}${step.by.length ? ` GROUP BY ${step.by.map(q).join(', ')}` : ''}`;
        }
        case 'unpivot': {
            if (!step.columns.length) { throw new Error('Choose the columns to turn into rows'); }
            return `UNPIVOT ${a} ON ${step.columns.map(q).join(', ')} INTO NAME ${q(step.name || 'name')} VALUE ${q(step.value || 'value')}`;
        }
        case 'window': {
            const over = [
                step.partition.length ? `PARTITION BY ${step.partition.map(q).join(', ')}` : '',
                step.order ? `ORDER BY ${q(step.order)} ${step.descending ? 'DESC' : 'ASC'}` : '',
            ].filter(Boolean).join(' ');
            const needsColumn = step.fn !== 'row number' && step.fn !== 'rank' && step.fn !== 'running count';
            if (needsColumn && !step.column) { throw new Error('Choose a column'); }
            if ((step.fn === 'rank' || step.fn === 'previous value' || step.fn === 'next value' || step.fn.startsWith('running')) && !step.order) {
                throw new Error('Choose a column to order by');
            }
            const col = step.column ? q(step.column) : '';
            const expr = {
                'row number': `row_number() OVER (${over})`,
                'rank': `rank() OVER (${over})`,
                'running sum': `sum(${col}) OVER (${over})`,
                'running count': `count(*) OVER (${over})`,
                'previous value': `lag(${col}) OVER (${over})`,
                'next value': `lead(${col}) OVER (${over})`,
                'share of total': `${col} / sum(${col}) OVER (${step.partition.length ? `PARTITION BY ${step.partition.map(q).join(', ')}` : ''})`,
            }[step.fn];
            return `SELECT *, ${expr} AS ${q(step.as || 'value')} FROM ${a}`;
        }
        case 'sql': {
            if (!step.text.trim()) { throw new Error('Write a query that reads from input'); }
            return replaceInput(step.text.trim().replace(/;\s*$/, ''), a);
        }
        case 'table': case 'chart': return `SELECT * FROM ${a}`;
        case 'export': return `SELECT * FROM ${a}`;
    }
}

/** Steps a step depends on, inputs before the steps that use them */
export function upstream(steps: Step[], id: string): Step[] {
    const byId = new Map(steps.map(s => [s.id, s]));
    const order: Step[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (sid: string) => {
        if (seen.has(sid)) { return; }
        if (visiting.has(sid)) { throw new FlowError(sid, 'This step feeds into itself'); }
        const step = byId.get(sid);
        if (!step) { throw new FlowError(id, `Missing step ${sid}`); }
        visiting.add(sid);
        step.inputs.forEach(visit);
        visiting.delete(sid);
        seen.add(sid);
        order.push(step);
    };
    visit(id);
    return order;
}

/** Checks the step has its inputs connected */
export function checkInputs(step: Step): void {
    const needed = STEPS[step.type].inputs;
    if (step.inputs.length < needed || step.inputs.slice(0, needed).some(i => !i)) {
        throw new FlowError(step.id, needed === 2 ? 'Connect both inputs' : 'Connect an input');
    }
}

/** One DuckDB query for a step and everything before it */
export function compile(steps: Step[], id: string, ctx: CompileContext): Compiled {
    const chain = upstream(steps, id);
    const setup: string[] = [];
    const ctes: string[] = [];
    for (const step of chain) {
        checkInputs(step);
        let body: string;
        try {
            body = stepSql(step, step.inputs, ctx, setup);
        } catch (err) {
            if (err instanceof FlowError) { throw err; }
            throw new FlowError(step.id, err instanceof Error ? err.message : String(err));
        }
        ctes.push(`${q(step.id)} AS (\n    ${body.replace(/\n/g, '\n    ')}\n)`);
    }
    return { setup, sql: `WITH\n${ctes.join(',\n')}\nSELECT * FROM ${q(id)}` };
}

/** The COPY statement an Export step runs */
export function exportSql(steps: Step[], step: Step & { type: 'export' }, ctx: CompileContext): Compiled {
    const { setup, sql } = compile(steps, step.id, ctx);
    const options = { csv: 'FORMAT csv, HEADER true', parquet: 'FORMAT parquet', json: 'FORMAT json, ARRAY true', xlsx: 'FORMAT xlsx, HEADER true' }[step.format];
    if (!step.file) { throw new FlowError(step.id, 'Name the file to write'); }
    return { setup, sql: `COPY (\n${sql}\n) TO ${lit(ctx.path(step.file))} (${options})` };
}

/** A step id for a new step of this type: its type and the next free number */
export function newId(steps: Step[], type: StepType, hint?: string): string {
    const cleaned = (hint ?? type).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || type;
    // Step names start with a letter, like the names people can type
    const base = /^\d/.test(cleaned) ? `s_${cleaned}` : cleaned;
    const taken = new Set(steps.map(s => s.id));
    if (type === 'source' && !taken.has(base)) { return base; }
    for (let n = 1; ; n++) {
        const id = `${base}_${n}`;
        if (!taken.has(id)) { return id; }
    }
}

/** Parses a .qflow.json document, fixing what can be fixed and describing what can't */
export function parseFlow(text: string): { flow: FlowFile } | { error: string } {
    if (!text.trim()) { return { flow: { version: FLOW_VERSION, steps: [], layout: {} } }; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (err) { return { error: `This file isn't valid JSON: ${err instanceof Error ? err.message : err}` }; }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as FlowFile).steps)) {
        return { error: 'This file isn\'t a query flow: it has no "steps" list.' };
    }
    const flow = raw as FlowFile;
    if (flow.version > FLOW_VERSION) { return { error: `This flow was saved by a newer version of Query Data Files (format ${flow.version}).` }; }
    for (const step of flow.steps) {
        if (!step || typeof step.id !== 'string' || !(step.type in STEPS)) {
            return { error: `A step has an unknown type: ${JSON.stringify(step).slice(0, 80)}` };
        }
        step.inputs = Array.isArray(step.inputs) ? step.inputs : [];
        Object.assign(step, { ...defaultBody(step.type), ...step });
    }
    flow.layout = flow.layout && typeof flow.layout === 'object' ? flow.layout : {};
    return { flow };
}

/** The document text: steps and layout, then the outputs' SQL */
export function serializeFlow(flow: FlowFile): string {
    const layout = Object.entries(flow.layout).map(([id, [x, y]]) => `    ${JSON.stringify(id)}: [${Math.round(x)}, ${Math.round(y)}]`).join(',\n');
    const body = JSON.stringify({ version: FLOW_VERSION, steps: flow.steps }, null, 2);
    const outputs = JSON.stringify(flow.outputs ?? [], null, 2).replace(/\n/g, '\n  ');
    return `${body.slice(0, -2)},\n  "layout": {\n${layout}\n  },\n  "outputs": ${outputs}\n}\n`;
}
