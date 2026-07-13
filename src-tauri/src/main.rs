// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn to_absolute(path: std::path::PathBuf) -> std::path::PathBuf {
    use std::path::PathBuf;

    // Strip a leading `./` so cwd.join doesn't produce mixed-separator
    // paths like `F:\foo\.\bar.json`.
    let cleaned: PathBuf = match path.to_str() {
        Some(s) => s
            .strip_prefix("./")
            .or_else(|| s.strip_prefix(".\\"))
            .map(PathBuf::from)
            .unwrap_or(path.clone()),
        None => path.clone(),
    };

    if cleaned.is_absolute() {
        return cleaned;
    }

    // File may not exist yet (we're about to create it) — try
    // canonicalize first (resolves symlinks and normalizes), fall back
    // to cwd + relative join.
    if let Ok(c) = std::fs::canonicalize(&cleaned) {
        return c;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&cleaned))
        .unwrap_or(cleaned)
}

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    eprintln!("[main] args={:?}", args);
    #[cfg(feature = "flamegraph")]
    if let Some(out) = ferrum_lib::profile::extract_output_arg(&mut args) {
        let out = to_absolute(out);
        eprintln!("[main] profile-output detected: {}", out.display());
        ferrum_lib::profile::init(&out);
    } else {
        eprintln!("[main] no --profile-output flag");
    }

    ferrum_lib::run()
}
