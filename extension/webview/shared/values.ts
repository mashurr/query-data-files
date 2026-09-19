// Decodes Arrow results from the engine and formats values the way DuckDB prints them.
// Integers, decimals and timestamps stay exact (BigInt), so big ids never get rounded.

import { DataType, Type, tableFromIPC } from '@uwdata/flechette';

export interface Decoded {
    /** One value array per column, in column order (names can repeat after a join) */
    columns: unknown[][];
    types: DataType[];
    names: string[];
    rows: number;
}

export function decode(body: Uint8Array): Decoded {
    if (!body.length) { return { columns: [], types: [], names: [], rows: 0 }; }
    const table = tableFromIPC(body, { useBigInt: true, useDecimalInt: true, useBigIntTimestamp: true });
    const columns: unknown[][] = [];
    for (let i = 0; i < table.numCols; i++) {
        columns.push(Array.from(table.getChildAt(i).toArray() as ArrayLike<unknown>));
    }
    return {
        columns,
        types: table.schema.fields.map(f => f.type),
        names: table.schema.fields.map(f => f.name),
        rows: table.numRows,
    };
}

export function isNumericType(t: DataType): boolean {
    return t.typeId === Type.Int || t.typeId === Type.Float || t.typeId === Type.Decimal;
}

const pad = (n: number | bigint, width = 2) => String(n).padStart(width, '0');

const UNIT_PER_SECOND = [1n, 1000n, 1_000_000n, 1_000_000_000n];

function dateText(ms: number): string {
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const y = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
    return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Seconds since midnight and a fraction string from a count of `unit`s */
function clock(value: bigint, unit: number): string {
    const perSecond = UNIT_PER_SECOND[unit];
    let seconds = value / perSecond;
    let frac = value % perSecond;
    if (frac < 0n) { frac += perSecond; seconds -= 1n; }
    const daySeconds = ((seconds % 86400n) + 86400n) % 86400n;
    const hh = daySeconds / 3600n, mm = (daySeconds % 3600n) / 60n, ss = daySeconds % 60n;
    let text = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    if (frac !== 0n) {
        text += '.' + String(frac).padStart(String(perSecond).length - 1, '0').replace(/0+$/, '');
    }
    return text;
}

function timestampText(value: bigint, unit: number, zoned: boolean): string {
    const perSecond = UNIT_PER_SECOND[unit];
    let seconds = value / perSecond;
    if (value % perSecond < 0n) { seconds -= 1n; }
    const day = seconds >= 0n ? seconds / 86400n : (seconds - 86399n) / 86400n;
    return `${dateText(Number(day) * 86_400_000)} ${clock(value, unit)}${zoned ? '+00' : ''}`;
}

function decimalText(value: number | bigint, scale: number): string {
    if (!scale) { return String(value); }
    const negative = value < 0;
    const digits = String(negative ? -BigInt(value) : BigInt(value)).padStart(scale + 1, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function intervalText(value: unknown): string {
    if (typeof value === 'number' || typeof value === 'bigint') { return `${value}`; }
    const parts = Array.from(value as ArrayLike<number | bigint>, Number);
    const [months = 0, days = 0, nanos = 0] = parts;
    const out: string[] = [];
    const years = Math.trunc(months / 12), rest = months % 12;
    if (years) { out.push(`${years} year${Math.abs(years) === 1 ? '' : 's'}`); }
    if (rest) { out.push(`${rest} month${Math.abs(rest) === 1 ? '' : 's'}`); }
    if (days) { out.push(`${days} day${Math.abs(days) === 1 ? '' : 's'}`); }
    if (nanos || !out.length) { out.push(clock(BigInt(Math.round(nanos / 1000)), 2)); }
    return out.join(' ');
}

function blobText(bytes: Uint8Array): string {
    let text = '';
    for (const b of bytes.subarray(0, 64)) {
        text += b >= 32 && b < 127 && b !== 92 ? String.fromCharCode(b) : `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return bytes.length > 64 ? `${text}…` : text;
}

/** Doubles to 15 significant digits, like spreadsheets, so sums don't show float noise (0.1 + 0.2) */
function floatText(v: number): string {
    if (Number.isNaN(v)) { return 'nan'; }
    if (!Number.isFinite(v)) { return v > 0 ? 'inf' : '-inf'; }
    return String(Number(v.toPrecision(15)));
}

/** Text for one value, `nested` quoting strings the way DuckDB prints lists and structs */
export function formatValue(value: unknown, type: DataType, nested = false): string {
    if (value === null || value === undefined) { return 'NULL'; }
    switch (type.typeId) {
        case Type.Int:
            return String(value);
        case Type.Float:
            return floatText(Number(value));
        case Type.Decimal:
            return decimalText(value as number | bigint, type.scale);
        case Type.Bool:
            return value ? 'true' : 'false';
        case Type.Date:
            return dateText(Number(value));
        case Type.Time:
            return clock(BigInt(value as number | bigint), type.unit);
        case Type.Timestamp:
            return timestampText(BigInt(value as number | bigint), type.unit, !!type.timezone);
        case Type.Interval:
            return intervalText(value);
        case Type.Duration:
            return `${value}`;
        case Type.Binary: case Type.LargeBinary: case Type.BinaryView: case Type.FixedSizeBinary:
            return blobText(value as Uint8Array);
        case Type.Utf8: case Type.LargeUtf8: case Type.Utf8View:
            return nested ? `'${String(value).replace(/'/g, '\'\'')}'` : String(value);
        case Type.List: case Type.LargeList: case Type.FixedSizeList: case Type.ListView: case Type.LargeListView: {
            const child = type.children[0].type;
            return `[${Array.from(value as ArrayLike<unknown>, v => formatValue(v, child, true)).join(', ')}]`;
        }
        case Type.Struct: {
            const record = value as Record<string, unknown>;
            return `{${type.children.map(f => `'${f.name}': ${formatValue(record[f.name], f.type, true)}`).join(', ')}}`;
        }
        case Type.Map: {
            const entry = type.children[0].type as DataType & { children: { type: DataType }[] };
            const [keyType, valueType] = [entry.children[0].type, entry.children[1].type];
            const pairs = value instanceof Map ? [...value.entries()] : (value as [unknown, unknown][]);
            return `{${pairs.map(([k, v]) => `${formatValue(k, keyType, true)}=${formatValue(v, valueType, true)}`).join(', ')}}`;
        }
        case Type.Dictionary:
            return formatValue(value, type.dictionary, nested);
        case Type.Null:
            return 'NULL';
        default:
            return typeof value === 'object' ? JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v) : String(value);
    }
}

/** A plain number for charts: dates and timestamps become milliseconds since 1970 */
export function numberValue(value: unknown, type: DataType): number | null {
    if (value === null || value === undefined) { return null; }
    switch (type.typeId) {
        case Type.Decimal: return Number(value) / 10 ** type.scale;
        case Type.Timestamp: return Number(BigInt(value as number | bigint) * 1000n / UNIT_PER_SECOND[type.unit]);
        case Type.Date: case Type.Int: case Type.Float: return Number(value);
        case Type.Bool: return value ? 1 : 0;
        case Type.Dictionary: return numberValue(value, type.dictionary);
        default: {
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
        }
    }
}
