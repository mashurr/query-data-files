// SQL text helpers for queries the views build from clicks.

import { DataType, Type } from '@uwdata/flechette';
import { formatValue } from './values';

export function ident(name: string): string {
    return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function literal(text: string): string {
    return `'${text.replace(/'/g, '\'\'')}'`;
}

/** A SQL literal equal to a value read back from a result, or undefined for nested values */
export function valueLiteral(value: unknown, type: DataType, duckType: string): string | undefined {
    if (value === null || value === undefined) { return undefined; }
    switch (type.typeId) {
        case Type.Int: case Type.Float: case Type.Decimal: {
            const text = formatValue(value, type);
            return /^-?\d/.test(text) ? text : `${literal(text)}::${duckType}`;
        }
        case Type.Bool:
            return value ? 'true' : 'false';
        case Type.Utf8: case Type.LargeUtf8: case Type.Utf8View:
            return literal(String(value));
        case Type.Date: case Type.Timestamp: case Type.Time: case Type.Interval:
            return `${literal(formatValue(value, type))}::${duckType}`;
        case Type.Dictionary:
            return valueLiteral(value, type.dictionary, duckType);
        default:
            return undefined;
    }
}

/** Drops trailing semicolons and a trailing `--` comment so the statement can be wrapped */
export function trimStatement(sql: string): string {
    let s = sql.trim();
    for (;;) {
        const before = s.length;
        s = s.replace(/[;\s]+$/, '');
        const lineStart = s.lastIndexOf('\n') + 1;
        const comment = lineComment(s.slice(lineStart));
        if (comment >= 0) { s = s.slice(0, lineStart + comment); }
        if (s.length === before) { return s; }
    }
}

function lineComment(line: string): number {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) { if (c === quote) { quote = ''; } continue; }
        if (c === '\'' || c === '"') { quote = c; continue; }
        if (c === '-' && line[i + 1] === '-') { return i; }
    }
    return -1;
}

/** Words DuckDB won't take as a bare column name */
const RESERVED = new Set(('ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC BOTH CASE CAST CHECK COLLATE COLUMN CONSTRAINT CREATE ' +
    'DEFAULT DEFERRABLE DESC DESCRIBE DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FROM GRANT GROUP HAVING IN INITIALLY ' +
    'INTERSECT INTO LATERAL LEADING LIMIT NOT NULL OFFSET ON ONLY OR ORDER PIVOT PIVOT_LONGER PIVOT_WIDER PLACING PRIMARY QUALIFY ' +
    'REFERENCES RETURNING SELECT SHOW SOME SUMMARIZE SYMMETRIC TABLE THEN TO TRAILING TRUE UNION UNIQUE UNPIVOT USING VARIADIC ' +
    'WHEN WHERE WINDOW WITH').split(' '));
