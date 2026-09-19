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
    let exports: Vec<&serde_json::Value> = flow["outputs"]
        .as_array()
        .map(|outputs| outputs.iter().filter(|o| o["kind"] == "export").collect())
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
    for output in exports {
        let step = output["step"].as_str().unwrap_or("export");
        // ATTACH statements for DuckDB database sources come first
        for setup in output["setup"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str())
        {
            conn.execute_batch(setup)
                .map_err(|e| format!("{step}: {e}"))?;
        }
        let sql = output["sql"].as_str().ok_or(format!(
            "{step} has no SQL; open the flow in VS Code and save it"
        ))?;
        // DuckDB won't create the folder it writes into
        if let Some(parent) = output["file"].as_str().and_then(|f| Path::new(f).parent())
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("{step}: can't create {}: {e}", parent.display()))?;
        }
        let rows = conn.execute(sql, []).map_err(|e| format!("{step}: {e}"))?;
        println!("{step}: wrote {rows} rows");
    }
    Ok(())
}
