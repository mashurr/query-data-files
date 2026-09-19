//! The `serve` mode the extension talks to. One DuckDB database per process;
//! each session (an open editor, a chart, the query builder) gets its own
//! connection and worker thread so a slow query never blocks the others, and
//! can be interrupted on its own.

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use arrow::datatypes::{DataType, SchemaRef};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use duckdb::{Config, Connection, InterruptHandle};
use serde_json::{Value, json};

use crate::protocol::{Frame, read_frame, write_frame};
use crate::sql::{check_user_statement, ident, literal, safe_name, trim_statement};
use crate::xlsx;

const PAGE_SIZE: usize = 200;
const ROWS_LIMIT: usize = 200_000;
/// Lines up to 8 MB instead of DuckDB's 2 MB, so a CSV with one huge cell still opens. The
/// buffer stays at DuckDB's usual 32 MB: by default it grows to 16 times the line limit, and a
/// query over eight CSVs runs out of memory; much smaller, and the parallel reader refuses big files.
const CSV_LIMITS: &str = "max_line_size = 8388608, buffer_size = 33554432";

type Outbox = Sender<Frame>;

struct Request {
    id: u64,
    method: String,
    params: Value,
}

struct Session {
    jobs: Sender<Request>,
    interrupt: Arc<InterruptHandle>,
}

/// Databases attached by path (SQLite and DuckDB files), shared by every session.
#[derive(Default)]
struct Attached {
    by_path: HashMap<String, String>,
}

pub fn serve() -> io::Result<()> {
    let (outbox, outgoing) = mpsc::channel::<Frame>();
    let writer = thread::spawn(move || {
        let mut out = BufWriter::new(io::stdout().lock());
        for frame in outgoing {
            if write_frame(&mut out, &frame).is_err() {
                break;
            }
        }
    });

    let mut input = BufReader::new(io::stdin().lock());
    let mut root: Option<Connection> = None;
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let attached = Arc::new(Mutex::new(Attached::default()));

    while let Some(frame) = read_frame(&mut input)? {
        let id = frame.header["id"].as_u64().unwrap_or(0);
        let method = frame.header["method"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let session = frame.header["session"]
            .as_str()
            .unwrap_or("default")
            .to_string();
        let params = frame.header.get("params").cloned().unwrap_or(Value::Null);

        match method.as_str() {
            "init" => {
                let reply = match init(&params) {
                    Ok((conn, info)) => {
                        root = Some(conn);
                        ok(id, info, Vec::new())
                    }
                    Err(message) => fail(id, "init", &message),
                };
                let _ = outbox.send(reply);
            }
            "cancel" => {
                if let Some(s) = sessions.get(&session) {
                    s.interrupt.interrupt();
                }
                let _ = outbox.send(ok(id, json!({}), Vec::new()));
            }
            "close" => {
                sessions.remove(&session);
                let _ = outbox.send(ok(id, json!({}), Vec::new()));
            }
            "shutdown" => {
                let _ = outbox.send(ok(id, json!({}), Vec::new()));
                break;
            }
            _ => {
                let Some(conn) = root.as_ref() else {
                    let _ = outbox.send(fail(id, "init", "The engine hasn't been initialised."));
                    continue;
                };
                if !sessions.contains_key(&session) {
                    match start_session(conn, &session, outbox.clone(), attached.clone()) {
                        Ok(s) => {
                            sessions.insert(session.clone(), s);
                        }
                        Err(message) => {
                            let _ = outbox.send(fail(id, "internal", &message));
                            continue;
                        }
                    }
                }
                let request = Request { id, method, params };
                if sessions[&session].jobs.send(request).is_err() {
                    sessions.remove(&session);
                    let _ = outbox.send(fail(id, "internal", "The session stopped unexpectedly."));
                }
            }
        }
    }

    drop(sessions);
    drop(root);
    drop(outbox);
    let _ = writer.join();
    Ok(())
}

fn ok(id: u64, result: Value, body: Vec<u8>) -> Frame {
    Frame {
        header: json!({ "id": id, "ok": true, "result": result }),
        body,
    }
}

fn fail(id: u64, kind: &str, message: &str) -> Frame {
    Frame {
        header: json!({ "id": id, "ok": false, "error": { "kind": kind, "message": message } }),
        body: Vec::new(),
    }
}

fn init(params: &Value) -> Result<(Connection, Value), String> {
    let text = |key: &str| params[key].as_str().unwrap_or_default().to_string();
    let extension_dir = text("extensionDir");
    let temp_dir = text("tempDir");

    let mut config = Config::default()
        .with("autoinstall_known_extensions", "false")
        .and_then(|c| c.with("autoload_known_extensions", "false"))
        .and_then(|c| c.with("allow_community_extensions", "false"))
        .map_err(|e| message(&e))?;
    if !extension_dir.is_empty() {
        config = config
            .with("extension_directory", &extension_dir)
            .map_err(|e| message(&e))?;
    }
    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| message(&e))?;

    let mut extensions = serde_json::Map::new();
    for name in ["sqlite_scanner", "excel"] {
        let loaded = conn.execute_batch(&format!("LOAD {name}")).is_ok();
        extensions.insert(name.to_string(), json!(loaded));
    }

    let mut setup = Vec::new();
    if !temp_dir.is_empty() {
        // DuckDB won't create a missing spill folder, and large sorts fail without it
        let spill = Path::new(&temp_dir).join("spill");
        let _ = std::fs::create_dir_all(&spill);
        setup.push(format!(
            "SET temp_directory = {}",
            literal(&spill.to_string_lossy())
        ));
    }
    if let Some(limit) = params["memoryLimit"].as_str() {
        setup.push(format!("SET memory_limit = {}", literal(limit)));
    }
    if let Some(threads) = params["threads"].as_u64() {
        setup.push(format!("SET threads = {threads}"));
    }
    let list = |key: &str| -> String {
        let items: Vec<String> = params[key]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(literal).collect())
            .unwrap_or_default();
        format!("[{}]", items.join(", "))
    };
    if params["lockdown"].as_bool().unwrap_or(true) {
        setup.push(format!(
            "SET allowed_directories = {}",
            list("allowedDirectories")
        ));
        setup.push(format!("SET allowed_paths = {}", list("allowedPaths")));
        setup.push("SET enable_external_access = false".into());
        setup.push("SET lock_configuration = true".into());
    }
    setup.push("CREATE SCHEMA memory.qdf".into());
    for statement in setup {
        conn.execute_batch(&statement).map_err(|e| message(&e))?;
    }
    let version = conn.version().unwrap_or_default();
    Ok((
        conn,
        json!({ "version": version, "extensions": extensions }),
    ))
}

fn start_session(
    root: &Connection,
    name: &str,
    outbox: Outbox,
    attached: Arc<Mutex<Attached>>,
) -> Result<Session, String> {
    let conn = root.try_clone().map_err(|e| message(&e))?;
    let interrupt = conn.interrupt_handle();
    let (jobs, queue) = mpsc::channel::<Request>();
    let default_result = format!("{}_result", safe_name(name));
    thread::spawn(move || run_session(conn, queue, outbox, attached, default_result));
    Ok(Session { jobs, interrupt })
}

fn run_session(
    conn: Connection,
    queue: Receiver<Request>,
    outbox: Outbox,
    attached: Arc<Mutex<Attached>>,
    default_result: String,
) {
    for mut request in queue {
        if let Value::Object(params) = &mut request.params {
            params
                .entry("name")
                .or_insert_with(|| json!(default_result));
        } else {
            request.params = json!({ "name": default_result });
        }
        let started = Instant::now();
        let reply = match handle(&conn, &request, &attached) {
            Ok((mut result, body)) => {
                if let Value::Object(map) = &mut result {
                    map.insert("ms".into(), json!(started.elapsed().as_secs_f64() * 1000.0));
                }
                ok(request.id, result, body)
            }
            Err(e) => fail(request.id, e.kind, &e.message),
        };
        if outbox.send(reply).is_err() {
            break;
        }
    }
}

struct Failure {
    kind: &'static str,
    message: String,
}

impl From<duckdb::Error> for Failure {
    fn from(e: duckdb::Error) -> Self {
        let mut text = message(&e);
        let kind = if text.contains("INTERRUPT") {
            "cancelled"
        } else {
            "sql"
        };
        if text.starts_with("Out of Memory Error") {
            let first = text.lines().next().unwrap_or_default().to_string();
            text = format!(
                "{first}\n\nDuckDB may use half of this computer's memory. Try a query that keeps fewer rows or \
                 columns, or aggregate before sorting."
            );
        }
        if text.starts_with("Missing Extension Error") {
            text = "This needs a DuckDB extension that Query Data Files doesn't include. It reads local files: \
                    CSV, TSV, Parquet, JSON, Excel, SQLite and DuckDB."
                .into();
        }
        Failure {
            kind,
            message: text,
        }
    }
}

fn bad_request(message: impl Into<String>) -> Failure {
    Failure {
        kind: "request",
        message: message.into(),
    }
}

fn message(e: &duckdb::Error) -> String {
    match e {
        duckdb::Error::DuckDBFailure(_, Some(text)) => text.clone(),
        other => other.to_string(),
    }
}

type Reply = Result<(Value, Vec<u8>), Failure>;

fn handle(conn: &Connection, request: &Request, attached: &Mutex<Attached>) -> Reply {
    let p = &request.params;
    match request.method.as_str() {
        "open" => open(conn, p, attached),
        "query" => query(conn, p),
        "rows" => rows(conn, p),
        "page" => page(conn, p),
        "export" => export(conn, p),
        "drop" => {
            for name in p["names"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                conn.execute_batch(&format!(
                    "DROP TABLE IF EXISTS {}",
                    result_table(&json!({ "name": name }))
                ))?;
            }
            Ok((json!({}), Vec::new()))
        }
        "sheets" => {
            let names = xlsx::sheet_names(str_param(p, "path")?).map_err(bad_request)?;
            Ok((json!({ "sheets": names }), Vec::new()))
        }
        "describe" => {
            let sql = trim_statement(str_param(p, "sql")?);
            let columns = describe(conn, &format!("(\n{sql}\n)"))?;
            Ok((json!({ "columns": columns }), Vec::new()))
        }
        "execute" => {
            let sql = str_param(p, "sql")?;
            check_user_statement(sql).map_err(bad_request)?;
            let changed = conn.execute(trim_statement(sql), [])?;
            Ok((json!({ "changed": changed }), Vec::new()))
        }
        "ping" => Ok((json!({}), Vec::new())),
        other => Err(bad_request(format!("Unknown method {other}"))),
    }
}

fn str_param<'a>(p: &'a Value, key: &str) -> Result<&'a str, Failure> {
    p[key]
        .as_str()
        .ok_or_else(|| bad_request(format!("Missing parameter {key}")))
}

/// Results live in the in-memory database's `qdf` schema, not in temp tables, so
/// every session of a view (paging, profiles, charts) can read them.
fn result_table(p: &Value) -> String {
    format!(
        "memory.qdf.{}",
        ident(&safe_name(p["name"].as_str().unwrap_or("result")))
    )
}

/// Opens a data file as the session's `this` view. SQLite and DuckDB files are
/// attached read-only so every table in them can be queried by name too.
fn open(conn: &Connection, p: &Value, attached: &Mutex<Attached>) -> Reply {
    let path = str_param(p, "path")?;
    let format = str_param(p, "format")?;
    let mut info = json!({ "format": format });
    let source = match format {
        "csv" => format!("read_csv({}, {CSV_LIMITS})", literal(path)),
        "tsv" => format!("read_csv({}, delim = '\t', {CSV_LIMITS})", literal(path)),
        "parquet" => format!("read_parquet({})", literal(path)),
        "json" => format!("read_json({})", literal(path)),
        "xlsx" => {
            let sheets = xlsx::sheet_names(path).map_err(bad_request)?;
            let sheet = p["sheet"]
                .as_str()
                .map(str::to_string)
                .or_else(|| sheets.first().cloned());
            let Some(sheet) = sheet else {
                return Err(bad_request("This workbook has no sheets."));
            };
            info["sheets"] = json!(sheets);
            info["sheet"] = json!(sheet);
            format!("read_xlsx({}, sheet = {})", literal(path), literal(&sheet))
        }
        "sqlite" | "duckdb" => {
            let alias = attach(conn, path, format, attached)?;
            let tables = list_tables(conn, &alias)?;
            let table = p["table"]
                .as_str()
                .map(str::to_string)
                .or_else(|| tables.first().map(|t| t.0.clone()));
            info["alias"] = json!(alias);
            info["tables"] = json!(tables.iter().map(|t| &t.0).collect::<Vec<_>>());
            let Some(table) = table else {
                info["source"] = Value::Null;
                return Ok((info, Vec::new()));
            };
            let schema = tables
                .iter()
                .find(|t| t.0 == table)
                .map_or("main".to_string(), |t| t.1.clone());
            info["table"] = json!(table);
            format!("{}.{}.{}", ident(&alias), ident(&schema), ident(&table))
        }
        other => return Err(bad_request(format!("Unsupported format {other}"))),
    };
    conn.execute_batch(&format!(
        "CREATE OR REPLACE TEMP VIEW this AS SELECT * FROM {source}"
    ))?;
    info["source"] = json!(source);
    Ok((info, Vec::new()))
}

fn attach(
    conn: &Connection,
    path: &str,
    format: &str,
    attached: &Mutex<Attached>,
) -> Result<String, Failure> {
    let mut attached = attached.lock().unwrap();
    if let Some(alias) = attached.by_path.get(path) {
        return Ok(alias.clone());
    }
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let base = safe_name(&stem);
    let taken: Vec<&String> = attached.by_path.values().collect();
    let mut alias = base.clone();
    let mut n = 2;
    while taken.contains(&&alias) || ["memory", "system", "temp", "this"].contains(&alias.as_str())
    {
        alias = format!("{base}_{n}");
        n += 1;
    }
    let kind = if format == "sqlite" {
        "sqlite"
    } else {
        "duckdb"
    };
    conn.execute_batch(&format!(
        "ATTACH {} AS {} (TYPE {kind}, READ_ONLY)",
        literal(path),
        ident(&alias)
    ))?;
    attached.by_path.insert(path.to_string(), alias.clone());
    Ok(alias)
}

/// (table, schema) pairs of an attached database: tables first, then views, each by name.
fn list_tables(conn: &Connection, alias: &str) -> Result<Vec<(String, String)>, Failure> {
    let sql = "SELECT name, schema_name FROM (
                   SELECT table_name AS name, schema_name, 0 AS is_view FROM duckdb_tables() WHERE database_name = ?
                   UNION ALL
                   SELECT view_name, schema_name, 1 FROM duckdb_views() WHERE database_name = ? AND NOT internal
               ) ORDER BY is_view, name";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([alias, alias], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Runs a statement and keeps its result in a temporary table the grid pages
/// through. Statements that can't be stored that way (PRAGMA, EXPLAIN, COPY…)
/// run directly and return their rows in one go.
fn query(conn: &Connection, p: &Value) -> Reply {
    let raw = str_param(p, "sql")?;
    if p["user"].as_bool().unwrap_or(true) {
        check_user_statement(raw).map_err(bad_request)?;
    }
    let sql = trim_statement(raw);
    let table = result_table(p);
    let page_size = p["pageSize"].as_u64().map_or(PAGE_SIZE, |n| n as usize);

    let attempts = [
        // The query starts on line 1 so DuckDB's error positions match what was typed
        format!("CREATE OR REPLACE TABLE {table} AS {sql}\n"),
        format!("CREATE OR REPLACE TABLE {table} AS SELECT * FROM ({sql}\n)"),
    ];
    for attempt in &attempts {
        match conn.prepare(attempt).and_then(|mut s| s.execute([])) {
            Ok(_) => {
                let rows: i64 =
                    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
                let columns = describe(conn, &table)?;
                let body = arrow_ipc(
                    conn,
                    &format!("SELECT * FROM {table} LIMIT {page_size}"),
                    page_size,
                )?
                .1;
                return Ok((
                    json!({ "name": p["name"].as_str().unwrap_or("result"), "rows": rows, "columns": columns, "direct": false }),
                    body,
                ));
            }
            Err(e) => {
                let failure = Failure::from(e);
                if failure.kind == "cancelled" || !failure.message.starts_with("Parser Error") {
                    return Err(failure);
                }
            }
        }
    }

    let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {table}"));
    match arrow_ipc(conn, sql, ROWS_LIMIT) {
        Ok((schema, body, count, truncated)) => Ok((
            json!({ "name": null, "rows": count, "columns": columns_from_schema(&schema), "direct": true, "truncated": truncated }),
            body,
        )),
        Err(e) => Err(e),
    }
}

/// Runs a query and returns every row (up to a limit) without storing it.
/// Used for charts, profiles and previews, whose SQL the extension writes.
fn rows(conn: &Connection, p: &Value) -> Reply {
    let sql = trim_statement(str_param(p, "sql")?);
    let limit = p["limit"].as_u64().map_or(ROWS_LIMIT, |n| n as usize);
    let (schema, body, count, truncated) = arrow_ipc(conn, sql, limit)?;
    Ok((
        json!({ "rows": count, "columns": columns_from_schema(&schema), "truncated": truncated }),
        body,
    ))
}

fn page(conn: &Connection, p: &Value) -> Reply {
    let table = result_table(p);
    let offset = p["offset"].as_u64().unwrap_or(0);
    let limit = p["limit"].as_u64().map_or(PAGE_SIZE, |n| n as usize);
    let (_, body, count, _) = arrow_ipc(
        conn,
        &format!("SELECT * FROM {table} LIMIT {limit} OFFSET {offset}"),
        limit,
    )?;
    Ok((json!({ "offset": offset, "rows": count }), body))
}

fn export(conn: &Connection, p: &Value) -> Reply {
    let table = result_table(p);
    let path = str_param(p, "path")?;
    let options = match str_param(p, "format")? {
        "csv" => "FORMAT csv, HEADER true",
        "parquet" => "FORMAT parquet",
        "json" => "FORMAT json, ARRAY true",
        "jsonl" => "FORMAT json",
        "xlsx" => "FORMAT xlsx, HEADER true",
        other => return Err(bad_request(format!("Unsupported export format {other}"))),
    };
    let written = conn.execute(
        &format!("COPY {table} TO {} ({options})", literal(path)),
        [],
    )?;
    Ok((json!({ "rows": written }), Vec::new()))
}

fn describe(conn: &Connection, table: &str) -> Result<Vec<Value>, Failure> {
    let mut stmt = conn.prepare(&format!("DESCRIBE {table}"))?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({ "name": r.get::<_, String>(0)?, "type": r.get::<_, String>(1)? }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Executes `sql` and encodes up to `limit` rows as one Arrow IPC stream.
/// Returns the schema, the bytes, the row count and whether rows were cut off.
fn arrow_ipc(
    conn: &Connection,
    sql: &str,
    limit: usize,
) -> Result<(SchemaRef, Vec<u8>, usize, bool), Failure> {
    let mut stmt = conn.prepare(sql)?;
    let arrow = stmt.stream_arrow([])?;
    let schema = arrow.get_schema();
    let mut writer = StreamWriter::try_new(Vec::new(), &schema).map_err(internal)?;
    let mut count = 0usize;
    let mut truncated = false;
    for batch in arrow {
        let remaining = limit - count;
        if remaining == 0 {
            truncated = batch.num_rows() > 0;
            break;
        }
        let batch: RecordBatch = if batch.num_rows() > remaining {
            truncated = true;
            batch.slice(0, remaining)
        } else {
            batch
        };
        count += batch.num_rows();
        writer.write(&batch).map_err(internal)?;
    }
    writer.finish().map_err(internal)?;
    Ok((
        schema,
        writer.into_inner().map_err(internal)?,
        count,
        truncated,
    ))
}

fn internal(e: impl std::fmt::Display) -> Failure {
    Failure {
        kind: "internal",
        message: e.to_string(),
    }
}

fn columns_from_schema(schema: &SchemaRef) -> Vec<Value> {
    schema
        .fields()
        .iter()
        .map(|f| json!({ "name": f.name(), "type": duck_type(f.data_type()) }))
        .collect()
}

/// DuckDB-style type names for results that don't come from a stored table.
fn duck_type(t: &DataType) -> String {
    match t {
        DataType::Boolean => "BOOLEAN".into(),
        DataType::Int8 => "TINYINT".into(),
        DataType::Int16 => "SMALLINT".into(),
        DataType::Int32 => "INTEGER".into(),
        DataType::Int64 => "BIGINT".into(),
        DataType::UInt8 => "UTINYINT".into(),
        DataType::UInt16 => "USMALLINT".into(),
        DataType::UInt32 => "UINTEGER".into(),
        DataType::UInt64 => "UBIGINT".into(),
        DataType::Float16 | DataType::Float32 => "FLOAT".into(),
        DataType::Float64 => "DOUBLE".into(),
        DataType::Decimal128(p, s) | DataType::Decimal256(p, s) => format!("DECIMAL({p},{s})"),
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => "VARCHAR".into(),
        DataType::Binary
        | DataType::LargeBinary
        | DataType::BinaryView
        | DataType::FixedSizeBinary(_) => "BLOB".into(),
        DataType::Date32 | DataType::Date64 => "DATE".into(),
        DataType::Time32(_) | DataType::Time64(_) => "TIME".into(),
        DataType::Timestamp(_, Some(_)) => "TIMESTAMP WITH TIME ZONE".into(),
        DataType::Timestamp(_, None) => "TIMESTAMP".into(),
        DataType::Interval(_) | DataType::Duration(_) => "INTERVAL".into(),
        DataType::List(f) | DataType::LargeList(f) | DataType::ListView(f) => {
            format!("{}[]", duck_type(f.data_type()))
        }
        DataType::FixedSizeList(f, n) => format!("{}[{n}]", duck_type(f.data_type())),
        DataType::Struct(_) => "STRUCT".into(),
        DataType::Map(_, _) => "MAP".into(),
        DataType::Dictionary(_, v) => duck_type(v),
        DataType::Null => "NULL".into(),
        other => format!("{other:?}").to_uppercase(),
    }
}
