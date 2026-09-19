// Column profiles shown under each header: a small histogram, the share of NULLs and
// the number of distinct values. Two queries cover every column: one for counts over
// the whole result, one for histograms over a sample when the result is large.

import { Column } from '../../src/shared/protocol';
import { formatCount, h, svg } from '../shared/dom';
import { engine } from '../shared/rpc';
import { ident } from '../shared/sqltext';
import { decode } from '../shared/values';

const MAX_COLUMNS = 80;
const BINS = 18;
const TOP_VALUES = 6;
const SAMPLE_ROWS = 200_000;
const EXACT_DISTINCT_ROWS = 200_000;

export interface Profile {
    nulls: number;
    total: number;
    distinct: number | null;
    approximate: boolean;
    kind: 'number' | 'time' | 'text' | 'other';
    bars: number[];
    /** Hover text: range for numbers and times, top values for text */
    detail: string;
    sampled: boolean;
}

type Kind = Profile['kind'];

export function kindOf(type: string): Kind {
    const t = type.toUpperCase();
    if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/.test(t)) { return 'number'; }
    if (/^(DATE|TIMESTAMP)/.test(t)) { return 'time'; }
    if (/^(VARCHAR|BOOLEAN|UUID|ENUM)/.test(t) && !t.includes('[')) { return 'text'; }
    return 'other';
}

function first(rows: ReturnType<typeof decode>, name: string): unknown {
    const i = rows.names.indexOf(name);
    return i < 0 ? undefined : rows.columns[i]?.[0];
}

/** Profiles for a stored result, or undefined when it was cancelled or failed */
export async function computeProfiles(table: string, columns: Column[], rows: number): Promise<(Profile | undefined)[] | undefined> {
    const cols = columns.slice(0, MAX_COLUMNS).map((c, i) => ({ ...c, i, kind: kindOf(c.type), q: ident(c.name) }));
    if (!cols.length) { return []; }
    const exact = rows <= EXACT_DISTINCT_ROWS;
    const stats = ['count(*) AS n'];
    for (const c of cols) {
        stats.push(`count(${c.q}) AS n${c.i}`);
        if (c.kind !== 'other') {
            stats.push(exact ? `count(DISTINCT ${c.q}) AS d${c.i}` : `approx_count_distinct(${c.q}) AS d${c.i}`);
        }
        if (c.kind === 'number' || c.kind === 'time') {
            stats.push(`min(${c.q})::VARCHAR AS lo${c.i}`, `max(${c.q})::VARCHAR AS hi${c.i}`);
        }
    }
    const statsReply = await engine('profile', 'rows', { sql: `SELECT ${stats.join(', ')} FROM ${table}`, limit: 1 });
    if (!statsReply.ok) { return undefined; }
    const s = decode(statsReply.body);

    const sampled = rows > SAMPLE_ROWS;
    const branches: string[] = [];
    for (const c of cols) {
        if (c.kind === 'number' || c.kind === 'time') {
            const x = c.kind === 'time' ? `epoch(${c.q})` : `${c.q}::DOUBLE`;
            branches.push(`(SELECT ${c.i} AS i, CASE WHEN hi = lo THEN 0 ELSE least(${BINS - 1}, floor((x - lo) * ${BINS} / (hi - lo)))::INTEGER END AS b,
                NULL::VARCHAR AS v, count(*)::BIGINT AS n
                FROM (SELECT ${x} AS x FROM src WHERE ${c.q} IS NOT NULL AND isfinite(${x})),
                     (SELECT min(${x}) AS lo, max(${x}) AS hi FROM src WHERE ${c.q} IS NOT NULL AND isfinite(${x}))
                GROUP BY ALL)`);
        } else if (c.kind === 'text') {
            branches.push(`(SELECT ${c.i} AS i, NULL::INTEGER AS b, ${c.q}::VARCHAR AS v, count(*)::BIGINT AS n
                FROM src WHERE ${c.q} IS NOT NULL GROUP BY ALL ORDER BY n DESC, v LIMIT ${TOP_VALUES})`);
        }
    }
    const bins = new Map<number, { b: number | null; v: string | null; n: number }[]>();
    if (branches.length) {
        const needed = cols.filter(c => c.kind !== 'other').map(c => c.q).join(', ');
        const src = `SELECT ${needed} FROM ${table}${sampled ? ` USING SAMPLE ${SAMPLE_ROWS} ROWS` : ''}`;
        const reply = await engine('profile', 'rows', { sql: `WITH src AS MATERIALIZED (${src})\n${branches.join('\nUNION ALL\n')}` });
        if (!reply.ok) { return undefined; }
        const d = decode(reply.body);
        for (let r = 0; r < d.rows; r++) {
            const i = Number(d.columns[0][r]);
            const list = bins.get(i) ?? [];
            list.push({ b: d.columns[1][r] === null ? null : Number(d.columns[1][r]), v: d.columns[2][r] as string | null, n: Number(d.columns[3][r]) });
            bins.set(i, list);
        }
    }

    const total = Number(first(s, 'n') ?? 0);
    return columns.map((_, index) => {
        const c = cols[index];
        if (!c) { return undefined; }
        const nonNull = Number(first(s, `n${c.i}`) ?? 0);
        const distinctValue = first(s, `d${c.i}`);
        const list = bins.get(c.i) ?? [];
        let bars: number[] = [];
        let detail = '';
        if (c.kind === 'number' || c.kind === 'time') {
            bars = new Array(BINS).fill(0);
            for (const bin of list) { if (bin.b !== null) { bars[bin.b] += bin.n; } }
            const lo = first(s, `lo${c.i}`), hi = first(s, `hi${c.i}`);
            if (lo !== null && lo !== undefined) { detail = lo === hi ? `${lo}` : `${lo} to ${hi}`; }
        } else if (c.kind === 'text') {
            bars = list.map(b => b.n);
            const shown = sampled ? list.reduce((a, b) => a + b.n, 0) : nonNull;
            detail = list.slice(0, 3).map(b => `${b.v} (${shown ? Math.round(b.n * 100 / shown) : 0}%)`).join(', ');
        }
        return {
            nulls: total - nonNull,
            total,
            distinct: distinctValue === null || distinctValue === undefined ? null : Number(distinctValue),
            approximate: !exact,
            kind: c.kind,
            bars,
            detail,
            sampled,
        };
    });
}

const BAR_HEIGHT = 18;

export function renderProfile(profile: Profile | undefined, width: number): HTMLElement {
    const box = h('div', { className: 'prof' });
    if (!profile) {
        box.classList.add('loading');
        return box;
    }
    const w = Math.max(20, width - 16);
    const chart = svg('svg', { width: w, height: BAR_HEIGHT, viewBox: `0 0 ${w} ${BAR_HEIGHT}`, 'aria-hidden': 'true' });
    const max = Math.max(...profile.bars, 0);
    if (max > 0) {
        const slot = w / profile.bars.length;
        profile.bars.forEach((n, i) => {
            const bh = n ? Math.max(1.5, n / max * BAR_HEIGHT) : 0;
            chart.append(svg('rect', {
                class: profile.kind === 'text' && i > 0 ? 'bar other' : 'bar',
                x: (i * slot + 0.5).toFixed(1), y: (BAR_HEIGHT - bh).toFixed(1),
                width: Math.max(0.8, slot - 1.2).toFixed(1), height: bh.toFixed(1),
            }));
        });
    }
    box.append(chart);
    const nullShare = profile.total ? profile.nulls * 100 / profile.total : 0;
    const stats = h('div', { className: 'pstats' });
    if (profile.distinct !== null) {
        stats.append(`${profile.approximate ? '≈' : ''}${formatCount(profile.distinct)} distinct`);
    }
    if (nullShare > 0) {
        const share = nullShare < 0.1 ? '<0.1' : nullShare < 10 ? nullShare.toFixed(1) : String(Math.round(nullShare));
        if (stats.textContent) { stats.append(' · '); }
        stats.append(h('span', { className: 'has-nulls', text: `${share}% NULL` }));
    } else if (!stats.textContent) {
        stats.append('no NULLs');
    }
    box.append(stats);
    const tips = [profile.detail, `${formatCount(profile.nulls)} NULL${profile.nulls === 1 ? '' : 's'} of ${formatCount(profile.total)} rows`, profile.sampled && profile.kind !== 'other' ? `Histogram from a sample of ${formatCount(SAMPLE_ROWS)} rows` : '']
        .filter(Boolean);
    if (tips.length) { box.title = tips.join('\n'); }
    return box;
}

/** SQL reading a stored result from the engine */
export function resultTable(name: string): string {
    return `memory.qdf.${ident(name)}`;
}

