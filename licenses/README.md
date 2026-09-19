License texts of the DuckDB code shipped in each package, copied from the sources:

- `duckdb/`: [duckdb/duckdb](https://github.com/duckdb/duckdb) at v1.5.5, the prebuilt library, and the third-party code it contains.
- `duckdb-sqlite/`: [duckdb/duckdb-sqlite](https://github.com/duckdb/duckdb-sqlite), the `sqlite_scanner` extension. It embeds SQLite, which is in the public domain.
- `duckdb-excel/`: [duckdb/duckdb-excel](https://github.com/duckdb/duckdb-excel), the `excel` extension.

`scripts/licenses.py` adds these to every package with the licenses of the Rust crates, JavaScript packages and runtime libraries built into it.
- `crates/`: license texts of Rust crates published without one (duckdb, flatbuffers, winapi-x86_64-pc-windows-gnu), from their repositories.
