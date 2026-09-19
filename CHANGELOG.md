# Change Log

## [0.1.0]

- Opens CSV, TSV, Parquet, JSON, JSON Lines, Excel, SQLite and DuckDB files as a table, with a table or sheet picker for databases and workbooks.
- A SQL bar over every table: the file is `this`, and other files can be queried by path. Sorting, filtering and hiding columns from the table update the SQL.
- Column profiles under each header: a histogram, distinct values and NULLs.
- Charts picked from the columns and grouped by DuckDB; click a bar or point to see its rows.
- A visual query builder for `.qflow.json` files: sources, filters, joins, unions, groups, pivots, windows, formulas, SQL steps, charts and exports, with a preview at every step and Copy as SQL.
- Runs the SQL statement under the cursor in `.sql` files with Ctrl+Enter (Cmd+Enter on macOS).
- A Data Files view in the Explorer listing every data file with its tables and columns.
- Compare a data file with an earlier Git version: rows added, removed and changed.
- Export results as CSV, Parquet, JSON or Excel, or copy them as a Markdown table.
- Handles very large files: tens of millions of rows open in seconds and scroll end to end.
- Works offline with DuckDB 1.5.5 built in, and only reads files in the workspace or ones you open.
