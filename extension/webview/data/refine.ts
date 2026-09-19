// Filters, sorting and hidden columns picked in the grid, layered on the query the
// person wrote. The combined SQL is always shown in the SQL bar, so it can be edited.

import { ident, trimStatement } from '../shared/sqltext';

export interface Filter {
    column: string;
    op: '=' | '!=' | 'is null' | 'is not null';
    /** SQL literal for = and != */
    value?: string;
    /** Value as shown in the grid, for the chip */
    label?: string;
}

export interface Refinements {
    filters: Filter[];
    sort?: { column: string; descending: boolean };
    hidden: string[];
}

export const noRefinements = (): Refinements => ({ filters: [], hidden: [] });

export function isEmpty(r: Refinements): boolean {
    return !r.filters.length && !r.sort && !r.hidden.length;
}

const SIMPLE = /^select\s+\*\s+from\s+this$/i;

function condition(f: Filter): string {
    const col = ident(f.column);
    switch (f.op) {
        case 'is null': return `${col} IS NULL`;
        case 'is not null': return `${col} IS NOT NULL`;
        case '=': return `${col} = ${f.value}`;
        case '!=': return `${col} IS DISTINCT FROM ${f.value}`;
    }
}

/** The query that runs: the base query with the grid's refinements applied */
export function compose(base: string, r: Refinements): string {
    if (isEmpty(r)) { return base; }
    const trimmed = trimStatement(base);
    const from = SIMPLE.test(trimmed) ? 'this' : `(\n${trimmed.replace(/^/gm, '    ')}\n)`;
    const lines = [`SELECT *${r.hidden.length ? ` EXCLUDE (${r.hidden.map(ident).join(', ')})` : ''} FROM ${from}`];
    if (r.filters.length) {
        lines.push(`WHERE ${r.filters.map(condition).join('\n  AND ')}`);
    }
    if (r.sort) {
        lines.push(`ORDER BY ${ident(r.sort.column)} ${r.sort.descending ? 'DESC' : 'ASC'} NULLS LAST`);
    }
    return lines.join('\n');
}

export function describe(f: Filter): string {
    switch (f.op) {
        case 'is null': return `${f.column} is NULL`;
        case 'is not null': return `${f.column} is not NULL`;
        case '=': return `${f.column} = ${f.label ?? f.value}`;
        case '!=': return `${f.column} ≠ ${f.label ?? f.value}`;
    }
}
