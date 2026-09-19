// Charts of the current result. DuckDB groups the rows first, so a chart of 50 million
// rows only receives a few hundred points. Clicking a bar or point filters the table to it.

import { DataType } from '@uwdata/flechette';
import { Column } from '../../src/shared/protocol';
import { formatCount, h, svg } from '../shared/dom';
import { engine } from '../shared/rpc';
import { ident, literal } from '../shared/sqltext';
import { decode, formatValue, numberValue } from '../shared/values';
import { Profile, kindOf } from './profile';

export type ChartType = 'bar' | 'line' | 'histogram' | 'scatter';
export type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface ChartSettings {
    type: ChartType | 'auto';
    x?: string;
    y?: string;
    aggregate?: Aggregate;
    split?: string;
}

interface Resolved {
    type: ChartType;
    x: Column;
    /** Undefined means count of rows */
    y?: Column;
    aggregate: Aggregate;
    split?: Column;
}

/** A condition that selects the rows behind a clicked mark */
export interface Pick {
    condition: string;
    label: string;
}

const MAX_BARS = 20;
const MAX_SERIES = 7;
const MAX_POINTS = 5000;
const BUCKET_TARGET = 300;
const HEAT_X = 64;
const HEAT_Y = 40;
const HIST_BINS = 40;

const isIdLike = (name: string) => /(^id$|_id$|^id_)/i.test(name);

function categoryLike(c: Column, profile: Profile | undefined): boolean {
    const kind = kindOf(c.type);
    if (kind !== 'text') { return false; }
    return !profile || profile.distinct === null || profile.distinct <= 1000;
}

/** The chart the settings ask for, filling in whatever is on automatic */
export function resolve(settings: ChartSettings, columns: Column[], profiles: (Profile | undefined)[]): Resolved | undefined {
    const byName = (name?: string) => columns.find(c => c.name === name);
    const numbers = columns.filter(c => kindOf(c.type) === 'number');
    // Money-like names make better defaults than counts such as quantity
    const measureName = /(amount|revenue|sales|total|price|value|cost|profit|spend|income)/i;
    const measures = numbers.filter(c => !isIdLike(c.name)).sort((a, b) => Number(!measureName.test(a.name)) - Number(!measureName.test(b.name)));
    const times = columns.filter(c => kindOf(c.type) === 'time');
    const categories = columns.filter((c, i) => categoryLike(c, profiles[i]));
    const measure = measures[0] ?? numbers[0];

    let auto: Resolved | undefined;
    if (times.length && measure) { auto = { type: 'line', x: times[0], y: measure, aggregate: 'sum' }; }
    else if (categories.length && measure) { auto = { type: 'bar', x: categories[0], y: measure, aggregate: 'sum' }; }
    else if (measures.length >= 2) { auto = { type: 'scatter', x: measures[0], y: measures[1], aggregate: 'sum' }; }
    else if (measure) { auto = { type: 'histogram', x: measure, aggregate: 'count' }; }
    else if (categories.length) { auto = { type: 'bar', x: categories[0], aggregate: 'count' }; }
    else if (times.length) { auto = { type: 'line', x: times[0], aggregate: 'count' }; }
    if (settings.type === 'auto') { return auto; }

    const type = settings.type;
    let x = byName(settings.x);
    let y = byName(settings.y);
    const aggregate = settings.aggregate ?? (y ? 'sum' : 'count');
    if (type === 'histogram') {
        if (!x || kindOf(x.type) !== 'number') { x = measure; }
        return x ? { type, x, aggregate: 'count' } : undefined;
    }
    if (type === 'scatter') {
        if (!x || kindOf(x.type) !== 'number') { x = measures[0] ?? numbers[0]; }
        if (!y || kindOf(y.type) !== 'number' || y === x) { y = numbers.find(c => c !== x && !isIdLike(c.name)) ?? numbers.find(c => c !== x); }
        return x && y ? { type, x, y, aggregate: 'sum' } : undefined;
    }
    if (type === 'line' && (!x || kindOf(x.type) === 'text' || kindOf(x.type) === 'other')) { x = times[0] ?? numbers[0]; }
    if (type === 'bar' && !x) { x = categories[0] ?? columns[0]; }
    if (y && kindOf(y.type) !== 'number') { y = undefined; }
    if (!x) { return undefined; }
    const split = type === 'line' ? byName(settings.split) : undefined;
    return { type, x, y: aggregate === 'count' ? undefined : y ?? measure, aggregate: y || measure ? aggregate : 'count', split: split !== x ? split : undefined };
}

const valueSql = (r: Resolved) => r.aggregate === 'count' || !r.y ? 'count(*)' : `${r.aggregate}(${ident(r.y.name)})`;
const valueLabel = (r: Resolved) => r.aggregate === 'count' || !r.y ? 'Rows' : `${r.aggregate === 'avg' ? 'Average' : r.aggregate[0].toUpperCase() + r.aggregate.slice(1)} of ${r.y.name}`;

interface Series { name: string; points: { x: number; y: number; raw: unknown }[] }

type ChartData =
    | { type: 'bar'; bars: { label: string; value: number; raw: unknown; isNull: boolean; other?: number }[]; more: number }
    | { type: 'line'; series: Series[]; unit: string; xType: DataType; temporal: boolean }
    | { type: 'histogram'; bins: { lo: number; hi: number; n: number }[] }
    | { type: 'scatter'; points: { x: number; y: number }[] }
    | { type: 'heatmap'; cells: { i: number; j: number; n: number }[]; x0: number; x1: number; y0: number; y1: number };

const TIME_UNITS: [string, number][] = [
    ['second', 1], ['minute', 60], ['hour', 3600], ['day', 86400], ['week', 7 * 86400],
    ['month', 30.44 * 86400], ['quarter', 91.3 * 86400], ['year', 365.25 * 86400],
];

async function rows(sql: string, limit = 100_000) {
    const reply = await engine('chart', 'rows', { sql, limit });
    if (!reply.ok) { throw new Error(reply.error.message); }
    return decode(reply.body);
}

/** Runs the chart's queries against a stored result and returns what to draw */
async function load(r: Resolved, table: string): Promise<{ data: ChartData; sql: string }> {
    const x = ident(r.x.name);
    const value = valueSql(r);
    if (r.type === 'bar') {
        const additive = r.aggregate === 'count' || r.aggregate === 'sum';
        const sql = `WITH g AS (SELECT ${x} AS k, ${value} AS v FROM ${table} GROUP BY 1),
r AS (SELECT k, v, row_number() OVER (ORDER BY v DESC NULLS LAST, k) AS n FROM g)
SELECT n <= ${MAX_BARS - (additive ? 1 : 0)} AS top, ${additive ? 'CASE WHEN n <= ' + (MAX_BARS - 1) + ' THEN k END' : 'k'} AS k, ${additive ? 'sum(v)' : 'any_value(v)'} AS v, count(*) AS groups, min(n) AS n
FROM r ${additive ? '' : `WHERE n <= ${MAX_BARS} `}GROUP BY ALL ORDER BY n`;
        const d = await rows(sql);
        const bars = [];
        for (let i = 0; i < d.rows; i++) {
            const top = d.columns[0][i] as boolean;
            const raw = d.columns[1][i];
            const groups = Number(d.columns[3][i]);
            bars.push({
                label: top ? (raw === null ? 'NULL' : formatValue(raw, d.types[1])) : `Other (${formatCount(groups)})`,
                value: numberValue(d.columns[2][i], d.types[2]) ?? 0,
                raw, isNull: top && raw === null, other: top ? undefined : groups,
            });
        }
        let more = 0;
        if (!additive) {
            const count = await rows(`SELECT count(DISTINCT ${x}) + max(CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END) FROM ${table}`, 1);
            more = Math.max(0, Number(count.columns[0][0] ?? 0) - bars.length);
        }
        return { data: { type: 'bar', bars, more }, sql };
    }
    if (r.type === 'histogram') {
        const range = await rows(`SELECT min(${x})::DOUBLE, max(${x})::DOUBLE FROM ${table} WHERE isfinite(${x}::DOUBLE)`, 1);
        const lo = Number(range.columns[0][0] ?? 0), hi = Number(range.columns[1][0] ?? 0);
        const [start, step] = niceBins(lo, hi, HIST_BINS);
        const sql = `SELECT floor((${x}::DOUBLE - ${start}) / ${step})::BIGINT AS b, count(*) AS n
FROM ${table} WHERE isfinite(${x}::DOUBLE) GROUP BY 1 ORDER BY 1`;
        const d = await rows(sql);
        const bins = [];
        for (let i = 0; i < d.rows; i++) {
            const b = Number(d.columns[0][i]);
            bins.push({ lo: start + b * step, hi: start + (b + 1) * step, n: Number(d.columns[1][i]) });
        }
        return { data: { type: 'histogram', bins }, sql };
    }
    if (r.type === 'scatter') {
        const y = ident(r.y!.name);
        const count = await rows(`SELECT count(*) FROM ${table} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL`, 1);
        if (Number(count.columns[0][0]) <= MAX_POINTS) {
            const sql = `SELECT ${x}::DOUBLE, ${y}::DOUBLE FROM ${table} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL`;
            const d = await rows(sql);
            return { data: { type: 'scatter', points: Array.from({ length: d.rows }, (_, i) => ({ x: Number(d.columns[0][i]), y: Number(d.columns[1][i]) })) }, sql };
        }
        const range = await rows(`SELECT min(${x})::DOUBLE, max(${x})::DOUBLE, min(${y})::DOUBLE, max(${y})::DOUBLE FROM ${table}`, 1);
        const [x0, x1, y0, y1] = range.columns.map(c => Number(c[0]));
        const sx = (x1 - x0) / HEAT_X || 1, sy = (y1 - y0) / HEAT_Y || 1;
        const sql = `SELECT least(${HEAT_X - 1}, floor((${x}::DOUBLE - ${x0}) / ${sx}))::INT AS i, least(${HEAT_Y - 1}, floor((${y}::DOUBLE - ${y0}) / ${sy}))::INT AS j, count(*) AS n
FROM ${table} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL GROUP BY 1, 2  -- too many points to draw, so DuckDB bins them`;
        const d = await rows(sql);
        const cells = Array.from({ length: d.rows }, (_, i) => ({ i: Number(d.columns[0][i]), j: Number(d.columns[1][i]), n: Number(d.columns[2][i]) }));
        return { data: { type: 'heatmap', cells, x0, x1, y0, y1 }, sql };
    }

    // Line: time buckets sized so there are a few hundred points at most
    const temporal = kindOf(r.x.type) === 'time';
    const range = await rows(temporal
        ? `SELECT epoch(min(${x})), epoch(max(${x})) FROM ${table}`
        : `SELECT min(${x})::DOUBLE, max(${x})::DOUBLE FROM ${table} WHERE isfinite(${x}::DOUBLE)`, 1);
    const lo = Number(range.columns[0][0] ?? 0), hi = Number(range.columns[1][0] ?? 0);
    let bucket: string, unit: string;
    if (temporal) {
        const span = Math.max(1, hi - lo);
        unit = (TIME_UNITS.find(([, s]) => span / s <= BUCKET_TARGET) ?? TIME_UNITS[TIME_UNITS.length - 1])[0];
        bucket = /^DATE$/i.test(r.x.type) && ['second', 'minute', 'hour'].includes(unit) ? x : `date_trunc('${unit}', ${x})`;
        if (bucket === x) { unit = 'day'; }
    } else {
        const [start, step] = niceBins(lo, hi, BUCKET_TARGET);
        unit = String(step);
        bucket = hi === lo ? `${x}::DOUBLE` : `${start} + floor((${x}::DOUBLE - ${start}) / ${step}) * ${step}`;
    }
    let sql: string;
    if (r.split) {
        const s = ident(r.split.name);
        sql = `WITH top AS (SELECT ${s} AS s FROM ${table} GROUP BY 1 ORDER BY ${value} DESC NULLS LAST LIMIT ${MAX_SERIES})
SELECT ${bucket} AS x, CASE WHEN ${s} IN (SELECT s FROM top) THEN ${s}::VARCHAR ELSE 'Other' END AS series, ${value} AS v
FROM ${table} WHERE ${x} IS NOT NULL GROUP BY ALL ORDER BY 1`;
    } else {
        sql = `SELECT ${bucket} AS x, ${value} AS v FROM ${table} WHERE ${x} IS NOT NULL GROUP BY 1 ORDER BY 1`;
    }
    const d = await rows(sql);
    const seriesMap = new Map<string, Series>();
    const valueColumn = r.split ? 2 : 1;
    for (let i = 0; i < d.rows; i++) {
        const name = r.split ? String(d.columns[1][i] ?? 'NULL') : valueLabel(r);
        let series = seriesMap.get(name);
        if (!series) { series = { name, points: [] }; seriesMap.set(name, series); }
        const raw = d.columns[0][i];
        series.points.push({ x: numberValue(raw, d.types[0]) ?? 0, y: numberValue(d.columns[valueColumn][i], d.types[valueColumn]) ?? 0, raw });
    }
    const series = [...seriesMap.values()].sort((a, b) => (a.name === 'Other' ? 1 : 0) - (b.name === 'Other' ? 1 : 0));
    return { data: { type: 'line', series, unit, xType: d.types[0], temporal }, sql };
}

/** Round bin edges: a start below `lo` and a step giving about `count` bins */
function niceBins(lo: number, hi: number, count: number): [number, number] {
    if (!(hi > lo)) { return [lo - 0.5, 1]; }
    const step = niceStep((hi - lo) / count);
    return [Math.floor(lo / step) * step, step];
}

function niceStep(raw: number): number {
    const power = 10 ** Math.floor(Math.log10(raw));
    const f = raw / power;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

function ticks(lo: number, hi: number, count = 5): number[] {
    if (!(hi > lo)) { return [lo]; }
    const step = niceStep((hi - lo) / count);
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) { out.push(Number(v.toPrecision(12))); }
    return out;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
function short(v: number): string {
    if (Math.abs(v) >= 10_000) { return compact.format(v); }
    return Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function timeLabel(ms: number, unit: string): string {
    const d = new Date(ms);
    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const pad = (n: number) => String(n).padStart(2, '0');
    switch (unit) {
        case 'year': return String(d.getUTCFullYear());
        case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
        case 'month': return `${month} ${d.getUTCFullYear()}`;
        case 'week': case 'day': return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
        default: return `${month} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${unit === 'second' ? ':' + pad(d.getUTCSeconds()) : ''}`;
    }
}

const SERIES_COLORS = ['blue', 'orange', 'green', 'purple', 'red', 'yellow', 'foreground'];

/** Draws `data` into an SVG sized to `width` */
function draw(data: ChartData, r: Resolved, width: number, onPick: (pick: Pick) => void): SVGSVGElement {
    const W = Math.max(320, width);
    const x = ident(r.x.name);
    if (data.type === 'bar') {
        const bars = data.bars;
        const labelWidth = Math.min(220, Math.max(90, W * 0.26));
        const m = { l: labelWidth, r: 72, t: 24, b: 10 }, bh = 22, gap = 6;
        const H = m.t + bars.length * (bh + gap) + m.b;
        // "Other" can dwarf the real groups; it's drawn capped at the edge with its true total as the label
        const scaled = bars.filter(b => !b.other);
        const max = Math.max(0, ...scaled.map(b => b.value));
        const min = Math.min(0, ...scaled.map(b => b.value));
        const t = ticks(min, max || 1, 4);
        const lo = Math.min(min, t[0]), hi = Math.max(max, t[t.length - 1]) || 1;
        const sx = (v: number) => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r);
        const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Bar chart of ${valueLabel(r)} by ${r.x.name}` });
        for (const v of t) {
            root.append(svg('line', { class: 'grid-line', x1: sx(v), x2: sx(v), y1: m.t - 4, y2: H - m.b }));
            root.append(svg('text', { class: 'axis', x: sx(v), y: m.t - 9, 'text-anchor': 'middle' }, short(v)));
        }
        bars.forEach((b, i) => {
            const y = m.t + i * (bh + gap);
            const label = b.label.length > 30 ? b.label.slice(0, 29) + '…' : b.label;
            root.append(svg('text', { class: `axis label${b.isNull ? ' null' : ''}`, x: m.l - 8, y: y + bh / 2 + 4, 'text-anchor': 'end' }, label));
            const capped = Math.min(Math.max(b.value, lo), hi);
            const x0 = sx(Math.min(0, capped)), x1 = sx(Math.max(0, capped));
            const rect = svg('rect', { class: b.other ? 'mark other' : 'mark', x: x0, y, width: Math.max(1, x1 - x0), height: bh, rx: 2 });
            rect.append(svg('title', {}, `${b.label}: ${b.value.toLocaleString('en-US')}${b.other ? '' : '\nClick to see these rows'}`));
            if (!b.other) {
                rect.classList.add('pickable');
                rect.addEventListener('click', () => onPick({
                    condition: b.isNull ? `${x} IS NULL` : `${x} = ${literalFor(b.raw, b.label, r.x)}`,
                    label: `${r.x.name} = ${b.label}`,
                }));
            }
            root.append(rect);
            root.append(svg('text', { class: 'value', x: x1 + 6, y: y + bh / 2 + 4 }, short(b.value)));
        });
        return root;
    }

    const m = { l: 64, r: 24, t: 16, b: 36 };
    const H = 340;
    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const axes = (xs: number[], ys: number[], xLabel: (v: number) => string) => {
        const xt = ticks(Math.min(...xs), Math.max(...xs), Math.max(2, Math.floor(plotW / 110)));
        const yt = ticks(Math.min(0, ...ys), Math.max(...ys), 5);
        const x0 = Math.min(xt[0], ...xs), x1 = Math.max(xt[xt.length - 1], ...xs);
        const y0 = Math.min(yt[0], ...ys), y1 = Math.max(yt[yt.length - 1], ...ys);
        const sx = (v: number) => m.l + (x1 === x0 ? plotW / 2 : (v - x0) / (x1 - x0) * plotW);
        const sy = (v: number) => m.t + plotH - (y1 === y0 ? plotH / 2 : (v - y0) / (y1 - y0) * plotH);
        for (const v of yt) {
            root.append(svg('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }));
            root.append(svg('text', { class: 'axis', x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end' }, short(v)));
        }
        for (const v of xt) {
            root.append(svg('text', { class: 'axis', x: sx(v), y: H - m.b + 18, 'text-anchor': 'middle' }, xLabel(v)));
        }
        root.append(svg('line', { class: 'base-line', x1: m.l, x2: W - m.r, y1: m.t + plotH, y2: m.t + plotH }));
        return { sx, sy };
    };

    if (data.type === 'histogram') {
        const bins = data.bins;
        if (!bins.length) { return root; }
        const { sx, sy } = axes([bins[0].lo, bins[bins.length - 1].hi], bins.map(b => b.n), short);
        for (const b of bins) {
            const rect = svg('rect', { class: 'mark pickable', x: sx(b.lo) + 0.5, y: sy(b.n), width: Math.max(0.5, sx(b.hi) - sx(b.lo) - 1), height: Math.max(0, sy(0) - sy(b.n)) });
            rect.append(svg('title', {}, `${short(b.lo)} to ${short(b.hi)}: ${b.n.toLocaleString('en-US')} rows\nClick to see these rows`));
            rect.addEventListener('click', () => onPick({ condition: `${x} >= ${b.lo} AND ${x} < ${b.hi}`, label: `${r.x.name} ${short(b.lo)}–${short(b.hi)}` }));
            root.append(rect);
        }
        root.setAttribute('aria-label', `Histogram of ${r.x.name}`);
        return root;
    }

    if (data.type === 'scatter' || data.type === 'heatmap') {
        root.setAttribute('aria-label', `${r.y!.name} against ${r.x.name}`);
        if (data.type === 'scatter') {
            const pts = data.points;
            if (!pts.length) { return root; }
            const { sx, sy } = axes(pts.map(p => p.x), pts.map(p => p.y), short);
            for (const p of pts) { root.append(svg('circle', { class: 'mark dot', cx: sx(p.x).toFixed(1), cy: sy(p.y).toFixed(1), r: 2.6 })); }
        } else {
            const { sx, sy } = axes([data.x0, data.x1], [data.y0, data.y1], short);
            const max = Math.max(...data.cells.map(c => c.n));
            const cw = (data.x1 - data.x0) / HEAT_X, ch = (data.y1 - data.y0) / HEAT_Y;
            for (const c of data.cells) {
                const left = sx(data.x0 + c.i * cw), top = sy(data.y0 + (c.j + 1) * ch);
                const rect = svg('rect', {
                    class: 'mark', x: left.toFixed(1), y: top.toFixed(1),
                    width: Math.max(1, sx(data.x0 + (c.i + 1) * cw) - left).toFixed(1), height: Math.max(1, sy(data.y0 + c.j * ch) - top).toFixed(1),
                    'fill-opacity': (0.15 + 0.85 * Math.sqrt(c.n / max)).toFixed(2),
                });
                rect.append(svg('title', {}, `${c.n.toLocaleString('en-US')} rows`));
                root.append(rect);
            }
        }
        root.append(svg('text', { class: 'axis', x: W - m.r, y: H - 4, 'text-anchor': 'end' }, `${r.x.name} →`));
        root.append(svg('text', { class: 'axis', x: 4, y: 12 }, `↑ ${r.y!.name}`));
        return root;
    }

    // Line
    const all = data.series.flatMap(s => s.points);
    if (!all.length) { return root; }
    const { sx, sy } = axes(all.map(p => p.x), all.map(p => p.y), v => data.temporal ? timeLabel(v, data.unit) : short(v));
    root.setAttribute('aria-label', `${valueLabel(r)} by ${r.x.name}`);
    data.series.forEach((s, si) => {
        const color = SERIES_COLORS[si % SERIES_COLORS.length];
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
        if (data.series.length === 1 && s.points.length > 1) {
            const base = sy(0);
            root.append(svg('path', { class: 'area', d: `${d} L${sx(s.points[s.points.length - 1].x).toFixed(1)} ${base} L${sx(s.points[0].x).toFixed(1)} ${base} Z` }));
        }
        root.append(svg('path', { class: `line series-${color}`, d }));
        const radius = s.points.length > 120 ? 0 : 3;
        for (const p of s.points) {
            const label = data.temporal ? timeLabel(p.x, data.unit) : short(p.x);
            const dot = svg('circle', { class: `point series-${color} pickable`, cx: sx(p.x).toFixed(1), cy: sy(p.y).toFixed(1), r: radius || 5, 'fill-opacity': radius ? 1 : 0 });
            dot.append(svg('title', {}, `${data.series.length > 1 ? s.name + '\n' : ''}${label}: ${p.y.toLocaleString('en-US')}\nClick to see these rows`));
            dot.addEventListener('click', () => {
                const bucketCondition = data.temporal
                    ? (/^DATE$/i.test(r.x.type) && data.unit === 'day' ? `${x} = ${literal(formatValue(p.raw, data.xType))}::DATE` : `date_trunc('${data.unit}', ${x}) = ${literal(formatValue(p.raw, data.xType))}::TIMESTAMP`)
                    : `${x} >= ${p.x} AND ${x} < ${p.x + Number(data.unit)}`;
                const seriesCondition = r.split && s.name !== 'Other' ? ` AND ${ident(r.split.name)}::VARCHAR = ${literal(s.name)}` : '';
                onPick({ condition: bucketCondition + seriesCondition, label: `${r.x.name} ${label}${seriesCondition ? ', ' + s.name : ''}` });
            });
            root.append(dot);
        }
    });
    return root;
}

function literalFor(raw: unknown, label: string, column: Column): string {
    const kind = kindOf(column.type);
    if (kind === 'number') { return label; }
    if (typeof raw === 'boolean') { return raw ? 'true' : 'false'; }
    return kind === 'text' ? literal(String(raw)) : `${literal(label)}::${column.type}`;
}

/** The chart tab: controls, the chart and the query DuckDB ran for it */
export class ChartView {
    private readonly controls = h('div', { className: 'chart-controls' });
    private readonly area = h('div', { className: 'chart-area' });
    private readonly legend = h('div', { className: 'chart-legend' });
    private readonly footer = h('details', { className: 'chart-sql' });
    private token = 0;
    private last: { data: ChartData; r: Resolved } | undefined;

    constructor(host: HTMLElement, private readonly onSettings: (s: ChartSettings) => void, private readonly onPick: (pick: Pick) => void) {
        host.classList.add('chart');
        host.append(this.controls, this.area, this.legend, this.footer);
        new ResizeObserver(() => this.redraw()).observe(this.area);
    }

    async show(settings: ChartSettings, columns: Column[], profiles: (Profile | undefined)[], table: string | null, rowCount: number) {
        const token = ++this.token;
        const r = table ? resolve(settings, columns, profiles) : undefined;
        this.renderControls(settings, columns, r);
        this.legend.replaceChildren();
        this.footer.replaceChildren();
        this.last = undefined;
        if (!table) {
            this.area.replaceChildren(h('p', { className: 'empty', text: 'This result can\'t be charted. Charts work on query results, not on statements like PRAGMA or EXPLAIN.' }));
            return;
        }
        if (!r) {
            this.area.replaceChildren(h('p', { className: 'empty', text: 'No column here can be charted. Charts need a number, a date or a text column.' }));
            return;
        }
        if (!rowCount) {
            this.area.replaceChildren(h('p', { className: 'empty', text: 'No rows to chart.' }));
            return;
        }
        this.area.replaceChildren(h('p', { className: 'empty', text: 'Grouping rows…' }));
        let loaded;
        try {
            loaded = await load(r, table);
        } catch (err) {
            if (token === this.token) {
                this.area.replaceChildren(h('pre', { className: 'chart-error', text: err instanceof Error ? err.message : String(err) }));
            }
            return;
        }
        if (token !== this.token) { return; }
        this.last = { data: loaded.data, r };
        this.redraw();
        const points = loaded.data.type === 'bar' ? loaded.data.bars.length
            : loaded.data.type === 'line' ? loaded.data.series.reduce((n, s) => n + s.points.length, 0)
                : loaded.data.type === 'histogram' ? loaded.data.bins.length
                    : loaded.data.type === 'scatter' ? loaded.data.points.length : loaded.data.cells.length;
        const more = loaded.data.type === 'bar' && loaded.data.more ? ` · ${formatCount(loaded.data.more)} more groups not shown` : '';
        this.footer.append(
            h('summary', { text: `${formatCount(points)} point${points === 1 ? '' : 's'} from ${formatCount(rowCount)} rows${more} · Query DuckDB ran` }),
            h('pre', { text: loaded.sql }),
        );
        if (loaded.data.type === 'line' && loaded.data.series.length > 1) {
            this.legend.append(...loaded.data.series.map((s, i) => h('span', { className: `key series-${SERIES_COLORS[i % SERIES_COLORS.length]}`, text: s.name })));
        }
    }

    private redraw() {
        if (!this.last) { return; }
        this.area.replaceChildren(draw(this.last.data, this.last.r, this.area.clientWidth - 8, this.onPick));
    }

    private renderControls(settings: ChartSettings, columns: Column[], r: Resolved | undefined) {
        const select = (label: string, id: string, options: [string, string][], value: string, change: (v: string) => void) => {
            const el = h('select', { id, 'aria-label': label });
            el.append(...options.map(([v, text]) => h('option', { value: v, text })));
            el.value = value;
            el.addEventListener('change', () => change(el.value));
            return h('label', { for: id }, `${label} `, el);
        };
        const typeName = { bar: 'bar', line: 'line', histogram: 'histogram', scatter: 'scatter' };
        const update = (patch: Partial<ChartSettings>) => this.onSettings({ ...settings, type: settings.type === 'auto' && r ? r.type : settings.type, x: r?.x.name, y: r?.y?.name, aggregate: r?.aggregate, split: r?.split?.name, ...patch });
        const items = [select('Chart', 'chart-type', [['auto', `Automatic${r ? ` (${typeName[r.type]})` : ''}`], ['bar', 'Bar'], ['line', 'Line'], ['histogram', 'Histogram'], ['scatter', 'Scatter']],
            settings.type, v => this.onSettings(v === 'auto' ? { type: 'auto' } : { type: v as ChartType }))];
        if (r) {
            const numeric = columns.filter(c => kindOf(c.type) === 'number');
            const xOptions = (r.type === 'histogram' || r.type === 'scatter' ? numeric : r.type === 'line' ? columns.filter(c => kindOf(c.type) === 'number' || kindOf(c.type) === 'time') : columns);
            items.push(select(r.type === 'histogram' ? 'Column' : 'X', 'chart-x', xOptions.map(c => [c.name, c.name]), r.x.name, v => update({ x: v })));
            if (r.type === 'scatter') {
                items.push(select('Y', 'chart-y', numeric.map(c => [c.name, c.name]), r.y!.name, v => update({ y: v })));
            } else if (r.type !== 'histogram') {
                const aggregateOptions: [string, string][] = [['count', 'Count of rows'], ...numeric.flatMap(c => (['sum', 'avg', 'min', 'max'] as const).map(a => [`${a}:${c.name}`, `${a === 'avg' ? 'Average' : a[0].toUpperCase() + a.slice(1)} of ${c.name}`] as [string, string]))];
                items.push(select('Y', 'chart-y', aggregateOptions, r.aggregate === 'count' || !r.y ? 'count' : `${r.aggregate}:${r.y.name}`, v => {
                    const [aggregate, name] = v === 'count' ? ['count', undefined] : [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)];
                    update({ aggregate: aggregate as Aggregate, y: name });
                }));
            }
            if (r.type === 'line') {
                const splits = columns.filter(c => kindOf(c.type) === 'text');
                items.push(select('Split by', 'chart-split', [['', 'Nothing'], ...splits.map(c => [c.name, c.name] as [string, string])], r.split?.name ?? '', v => update({ split: v || undefined })));
            }
        }
        this.controls.replaceChildren(...items);
    }
}
