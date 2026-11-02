//! Rewind's settings, read once from the environment at startup.

use std::{
    fmt::Display,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

pub struct Config {
    pub url: String,
    pub entry: String,
    pub target_dir: PathBuf,
    pub target_start: String,
    pub project_dir: PathBuf,
    pub db_path: PathBuf,
    pub tests_dir: PathBuf,
    pub ui_dist: PathBuf,
    /// Where the preloads append what they capture around iii.
    pub capture_file: PathBuf,
    pub spans_path: PathBuf,
    /// Where Rewind finds the other workers it can start copies of.
    pub compose_file: PathBuf,
    /// How many copies of the worker under test Rewind keeps started for new forks. 0 starts none.
    pub pool_size: usize,
    /// How long a paused fork keeps its copies after its last rerun before Rewind closes them.
    pub paused_idle: Duration,
    /// The most paused forks that keep their copies open at once.
    pub paused_open: usize,
    /// How long recorded calls, forks and worker changes are kept. Zero keeps them however old.
    pub keep_for: Duration,
    /// How many of the newest runs are kept, with everything recorded since. Zero keeps every run.
    pub keep_runs: usize,
    /// How long the capture file grows before Rewind starts it over, once it has read all of it.
    pub capture_max_bytes: u64,
}

// The same preload records the live agent, so a copy runs exactly what it runs.
const TARGET_START: &str = "node --import tsx --import ../rewind/preload/node/index.mjs src/worker.ts";
// The page recovers four runs at once.
const POOL_SIZE: usize = 4;
// Long enough for a person to read a pause and answer it without a cold start.
const PAUSED_IDLE_SECS: u64 = 300;
// Two batches of four recoveries from the page, at about 100 MB a copy.
const PAUSED_OPEN: usize = 8;
// A demo records a few hundred runs in an afternoon, so these keep weeks of demos.
const KEEP_DAYS: u64 = 7;
const KEEP_RUNS: usize = 20_000;
const CAPTURE_MAX_MB: u64 = 64;
const DAY_SECS: u64 = 24 * 60 * 60;

impl Config {
    pub fn from_env() -> Self {
        let project_dir = project_dir();
        Self {
            url: env_or("III_URL", "ws://127.0.0.1:49334"),
            entry: env_or("REWIND_ENTRY", "agent::run"),
            target_dir: absolute(Path::new(&env_or("REWIND_TARGET_DIR", "../agent"))),
            target_start: env_or("REWIND_TARGET_START", TARGET_START),
            db_path: project_dir.join("data").join("rewind.sqlite"),
            spans_path: project_dir.join("data").join("spans.sqlite"),
            capture_file: absolute(Path::new(&env_or(
                "REWIND_CAPTURE_FILE",
                &project_dir.join("data").join("captures.jsonl").to_string_lossy(),
            ))),
            tests_dir: project_dir.join("tests").join("rewind"),
            ui_dist: absolute(Path::new(&env_or("REWIND_UI_DIST", "ui/dist"))),
            compose_file: absolute(Path::new(&env_or(
                "REWIND_COMPOSE_FILE",
                &project_dir.join("worker-compose.yaml").to_string_lossy(),
            ))),
            pool_size: number("REWIND_POOL_SIZE", POOL_SIZE),
            paused_idle: Duration::from_secs(number("REWIND_PAUSED_IDLE_SECS", PAUSED_IDLE_SECS)),
            paused_open: number("REWIND_PAUSED_OPEN", PAUSED_OPEN),
            keep_for: Duration::from_secs(number("REWIND_KEEP_DAYS", KEEP_DAYS).saturating_mul(DAY_SECS)),
            keep_runs: number("REWIND_KEEP_RUNS", KEEP_RUNS),
            capture_max_bytes: number("REWIND_CAPTURE_MAX_MB", CAPTURE_MAX_MB).saturating_mul(1024 * 1024),
            project_dir,
        }
    }
}

/// A whole number from the environment, or `default` when it is unset or not a number.
fn number<T: FromStr + Display + Copy>(name: &str, default: T) -> T {
    let text = env_or(name, &default.to_string());
    text.trim().parse().unwrap_or_else(|_| {
        eprintln!("rewind: {name} {text:?} is not a number, so Rewind uses {default}");
        default
    })
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }

    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

// Compose sets III_COMPOSE_DIR. Started by hand, Rewind finds the same folder
// by walking up to the compose file, the way the tools worker does.
fn project_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("III_COMPOSE_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir);
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cwd.ancestors()
        .find(|dir| dir.join("worker-compose.yaml").is_file())
        .map(Path::to_path_buf)
        .unwrap_or(cwd)
}
