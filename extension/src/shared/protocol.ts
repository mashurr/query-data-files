// Messages between the extension host, the engine and the webviews.

export interface EngineError {
    /** `sql`: DuckDB rejected the query; `cancelled`: stopped on request; `request`: bad input; `crashed`: engine stopped */
    kind: 'sql' | 'cancelled' | 'request' | 'crashed' | 'init' | 'internal';
    message: string;
}

export type EngineReply =
    | { ok: true; result: Record<string, unknown>; body: Uint8Array }
    | { ok: false; error: EngineError };

export interface Column {
    name: string;
    /** DuckDB type name, e.g. BIGINT, VARCHAR, DECIMAL(10,2), TIMESTAMP */
    type: string;
}

/** A stored query result the grid pages through */
export interface QueryResult {
    name: string | null;
    rows: number;
    columns: Column[];
    /** Statements like PRAGMA or EXPLAIN aren't stored; all their rows come in the first page */
    direct: boolean;
    truncated?: boolean;
    ms: number;
}

export type Format = 'csv' | 'tsv' | 'parquet' | 'json' | 'xlsx' | 'sqlite' | 'duckdb';

/** What the engine opened as `this` */
export interface OpenedFile {
    name: string;
    path: string;
    format: Format;
    /** DuckDB SQL that reads it, e.g. read_csv('/data/orders.csv') */
    source: string | null;
    tables?: string[];
    table?: string;
    sheets?: string[];
    sheet?: string;
    /** Name SQLite and DuckDB files are attached under */
    alias?: string;
}

/** Separate engine connections for one view, so paging never waits behind a slow query */
export type Lane = 'main' | 'peek' | 'page' | 'profile' | 'chart' | 'diff';

export type ViewMessage =
    | { type: 'ready' }
    | { type: 'engine'; rid: number; lane: Lane; method: string; params: Record<string, unknown> }
    | { type: 'cancel'; lanes: Lane[] }
    | { type: 'openTable'; table?: string; sheet?: string }
    | { type: 'export'; format: 'csv' | 'parquet' | 'json' | 'xlsx'; name: string; rows: number }
    | { type: 'copy'; text: string; what: string }
    | { type: 'error'; message: string };

export interface ViewInit {
    type: 'init';
    kind: 'file' | 'sql';
    title: string;
    file?: OpenedFile;
    sql: string;
    /** Set when the file couldn't be opened */
    problem?: string;
}

export type HostMessage =
    | ViewInit
    | { type: 'reply'; rid: number; reply: EngineReply }
    | { type: 'opened'; file?: OpenedFile; problem?: string }
    | { type: 'reset' }
    | { type: 'run'; sql: string };
