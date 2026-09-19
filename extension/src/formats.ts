import * as fs from 'fs';
import * as path from 'path';
import { Format } from './shared/protocol';

const BY_EXTENSION: Record<string, Format> = {
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.parquet': 'parquet',
    '.json': 'json',
    '.jsonl': 'json',
    '.ndjson': 'json',
    '.xlsx': 'xlsx',
    '.sqlite': 'sqlite',
    '.sqlite3': 'sqlite',
    '.duckdb': 'duckdb',
};

export const DATA_EXTENSIONS = [...Object.keys(BY_EXTENSION), '.db'].map(e => e.slice(1));

/** The format to read a file as; `.db` files are told apart by their first bytes */
export function formatOf(file: string): Format | undefined {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.db') { return sniffDatabase(file); }
    return BY_EXTENSION[ext];
}

function sniffDatabase(file: string): Format | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        if (head.toString('latin1', 0, 15) === 'SQLite format 3') { return 'sqlite'; }
        if (head.toString('latin1', 8, 12) === 'DUCK') { return 'duckdb'; }
        return undefined;
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) { fs.closeSync(fd); }
    }
}
