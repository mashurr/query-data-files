mod protocol;
mod server;
mod sql;
mod xlsx;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use duckdb::{Config, Connection};

const USAGE: &str = "Usage:
  qdf-engine serve              talk to the Query Data Files extension over stdin/stdout
  qdf-engine run <file.qflow>   run every Export step of a saved query flow
  qdf-engine --version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => match server::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("qdf-engine: {e}");
                ExitCode::FAILURE
            }
        },
        Some("run") if args.len() == 2 => match run_flow(Path::new(&args[1])) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Some("--version") => {
            println!("qdf-engine {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// Bundled DuckDB extensions sit in `extensions/` next to the `bin/` folder.
fn bundled_extensions() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("extensions");
    dir.is_dir().then_some(dir)
}

/// Runs the SQL the extension saved for each Export step, from the flow file's folder
/// so relative file names resolve the same way they do in the editor.
fn run_flow(path: &Path) -> Result<(), String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    let flow: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} isn't valid JSON: {e}", path.display()))?;
    let exports: Vec<(&str, &str)> = flow["outputs"]
        .as_array()
        .map(|outputs| {
            outputs
                .iter()
                .filter(|o| o["kind"] == "export")
                .filter_map(|o| Some((o["step"].as_str().unwrap_or("export"), o["sql"].as_str()?)))
                .collect()
        })
        .unwrap_or_default();
    if exports.is_empty() {
        return Err(format!("{} has no Export steps to run.", path.display()));
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::env::set_current_dir(dir)
            .map_err(|e| format!("Can't switch to {}: {e}", dir.display()))?;
    }

    let mut config = Config::default()
        .with("autoinstall_known_extensions", "false")
        .and_then(|c| c.with("autoload_known_extensions", "false"))
        .map_err(|e| e.to_string())?;
    if let Some(dir) = bundled_extensions() {
        config = config
            .with("extension_directory", dir.to_string_lossy())
            .map_err(|e| e.to_string())?;
    }
    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
    for name in ["sqlite_scanner", "excel"] {
        let _ = conn.execute_batch(&format!("LOAD {name}"));
    }
    for (step, sql) in exports {
        let rows = conn.execute(sql, []).map_err(|e| format!("{step}: {e}"))?;
        println!("{step}: wrote {rows} rows");
    }
    Ok(())
}
