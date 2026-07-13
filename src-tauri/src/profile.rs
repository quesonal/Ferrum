//! Startup profiling utilities.
//!
//! Compiles to a thin no-op when the `flamegraph` feature is disabled so
//! that release builds have zero overhead. With the feature enabled, the
//! `tracing-chrome` backend writes a JSON file in the Chrome trace format
//! that can be opened in <https://ui.perfetto.dev> for a flame-graph view
//! of the startup timeline.
//!
//! # Usage
//!
//! ```bash
//! # 1. Build with profiling enabled
//! cargo run --features flamegraph -- --profile-output ./flamegraph.json
//!
//! # 2. After the app has been running for a few seconds, quit it.
//!    The trace file is flushed on exit.
//!
//! # 3. Open the JSON at https://ui.perfetto.dev
//! ```
//!
//! In the Perfetto UI:
//! - The "Main" track shows the top-level spans (e.g. `ferrum::run`,
//!   `tauri::setup`, plugin init spans).
//! - The "Async" track shows the per-plugin initialization order.
//! - Hover any block to see its duration, the time it started relative
//!   to `main()`, and the parent span.
//!
//! # Filtering
//!
//! The default `RUST_LOG=info` filter keeps the trace compact. To see
//! everything (including debug/trace events from dependencies), set
//! `RUST_LOG=trace` before launching.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Returns `true` if the profiler backend was compiled in.
pub const fn is_enabled() -> bool {
    cfg!(feature = "flamegraph")
}

/// Path where the Rust trace file is written. Set in `init()` and read by
/// `lib.rs::run` to filter it out of `env::args()` when computing
/// `initial_path` (otherwise the profile output path would be mistaken
/// for a file the user wanted to open). `None` when profiling is
/// disabled.
static OUTPUT_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Path where the frontend trace events are written. Set in `init()` and
/// read once by `lib.rs::run` to inject it into the frontend init script.
/// `None` when profiling is disabled.
static FRONTEND_TRACE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Returns the Rust trace output path (the value of `--profile-output`),
/// or `None` if profiling is disabled.
pub fn output_path() -> Option<PathBuf> {
    OUTPUT_PATH.get().cloned()
}

/// Returns the path where frontend trace events should be written, or
/// `None` if profiling is disabled. Frontend reads this from
/// `window.__FRONTEND_TRACE_PATH__`.
pub fn frontend_trace_path() -> Option<PathBuf> {
    FRONTEND_TRACE_PATH.get().cloned()
}

/// Pull the `--profile-output <path>` flag out of `args` in place.
/// Returns the parsed path if the flag was present. Used by both
/// `main.rs` (to consume the flag before Tauri sees it) and `lib.rs`
/// (to filter the same path out when computing the initial file).
///
/// Supports both `--profile-output <path>` and `--profile-output=<path>`.
pub fn extract_output_arg(args: &mut Vec<String>) -> Option<PathBuf> {
    if let Some(pos) = args.iter().position(|a| a == "--profile-output") {
        if let Some(val) = args.get(pos + 1) {
            let path = PathBuf::from(val);
            args.remove(pos + 1);
            args.remove(pos);
            return Some(path);
        }
    }

    if let Some(pos) = args
        .iter()
        .position(|a| a.starts_with("--profile-output="))
    {
        let val = &args[pos]["--profile-output=".len()..];
        let path = PathBuf::from(val);
        args.remove(pos);
        return Some(path);
    }

    None
}

/// Derive the frontend trace path from a Rust trace path. Replaces the
/// file stem's suffix with `.frontend.json`, keeping the same directory.
/// Example: `./flamegraph-r2.json` -> `./flamegraph-r2.frontend.json`.
pub fn derive_frontend_trace_path(rust_path: &Path) -> PathBuf {
    let mut p = rust_path.to_path_buf();
    let stem = p
        .file_stem()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    let mut name = stem;
    name.push(".frontend.json");
    p.set_file_name(name);
    p
}

/// Initialize the Chrome trace profiler. Writes a trace event file to
/// `output`. Returns silently if the profiler is already running or if
/// the `profile` feature is disabled.
///
/// Implementation notes:
/// - The `FlushGuard` from `tracing-chrome` is parked in a
///   `Mutex<FlushGuard>` inside a `OnceLock` (it is `Send` but not
///   `Sync`, so the `Mutex` provides the `Sync` requirement for the
///   static). We never lock it for read; it exists only to keep the
///   guard alive for the process lifetime so its `Drop` joins the
///   background writer thread on exit.
/// - A separate flush thread ticks every `FLUSH_INTERVAL_MS` and
///   calls `FlushGuard::flush()`. This is important because
///   `tracing-chrome` writes through a `BufWriter<...>` with an 8 KiB
///   buffer; without periodic flushes the trace file stays empty
///   (or is only partially written) when the process is killed or
///   closed mid-startup. 500 ms is short enough that the file is
///   usable even on a hard kill, and long enough not to spam syscalls.
#[cfg(feature = "flamegraph")]
pub fn init(output: &Path) {
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    const FLUSH_INTERVAL_MS: u64 = 500;

    static GUARD: OnceLock<Mutex<tracing_chrome::FlushGuard>> = OnceLock::new();
    if GUARD.get().is_some() {
        return;
    }

    // Stash the Rust + frontend trace paths so `lib.rs::run` can:
    // - filter the Rust path out of `env::args()` (so the profile output
    //   isn't mistaken for a file the user wanted to open)
    // - inject the frontend path into the init script
    let _ = OUTPUT_PATH.set(output.to_path_buf());
    let _ = FRONTEND_TRACE_PATH.set(derive_frontend_trace_path(output));

    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let (chrome_layer, guard) = tracing_chrome::ChromeLayerBuilder::new()
        .file(output.to_string_lossy().to_string())
        .include_args(true)
        .include_locations(false)
        .build();

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,ferrum_lib=trace,startup=trace"));

    let result = tracing_subscriber::registry()
        .with(filter)
        .with(chrome_layer)
        .try_init();

    if result.is_ok() {
        let _ = GUARD.set(Mutex::new(guard));
        eprintln!("[profile] profiler initialized, output={}", output.display());
        tracing::info!(target: "startup", path = %output.display(), "profiler initialized");

        // Spawn the periodic flush thread. The thread runs until the
        // process exits; it does its best-effort flush and is killed
        // by the OS along with everything else.
        std::thread::Builder::new()
            .name("profile-flusher".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(FLUSH_INTERVAL_MS));
                if let Some(g) = GUARD.get() {
                    if let Ok(guard) = g.lock() {
                        guard.flush();
                    }
                }
            })
            .expect("failed to spawn profile flush thread");
    } else {
        eprintln!(
            "[profile] could not install global subscriber (a subscriber was already set)"
        );
    }
}

/// Stub used when the `flamegraph` feature is disabled.
///
/// In practice this stub is unreachable because `lib.rs` gates the
/// entire `profile` module on `#[cfg(feature = "flamegraph")]`. It is
/// kept here only to satisfy any future caller that compiles without
/// the feature (e.g. a hypothetical test harness).
#[cfg(not(feature = "flamegraph"))]
pub fn init(_output: &Path) {
    // Intentionally a no-op. tracing::instrument! macros compile down
    // to a few atomic loads and string formatting only when a real
    // subscriber is installed, so this is genuinely free.
}

/// Emit a startup milestone event. Useful as a no-arg marker on the
/// timeline so you can align user-visible events (window shown, first
/// paint, ...) with the underlying span tree.
#[macro_export]
macro_rules! startup_event {
    ($($arg:tt)+) => {
        ::tracing::info!(target: "startup", $($arg)+);
    };
}

pub use startup_event;
