//! Reads the capture file the preloads append to, and stores each request under the iii
//! call it ran in, and each function span in the span store. It goes on from where it
//! stopped, and starts over when the file is shorter than that, as after clearing data/.

use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::{
    app::App,
    error::Result,
    outside::{self, Kind},
    spans::Span,
    store::{Event, Status},
};

const OFFSET_COUNTER: &str = "capture_offset";
const READ_EVERY: Duration = Duration::from_millis(200);
const SPAN_RUNS_KEPT: usize = 200;
const DROP_SPANS_EVERY: Duration = Duration::from_secs(30);
// A preload opens, writes one line and closes, so a line it began before the move is in by then.
const MOVE_GRACE: Duration = Duration::from_secs(1);

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Rewind may have stopped after it moved the file aside and before it finished reading it.
        if let Err(error) = finish_moved(&app) {
            eprintln!("rewind: could not finish reading the moved capture file: {error}");
        }

        let mut dropped_at = Instant::now();
        loop {
            if let Err(error) = read_new(&app) {
                eprintln!("rewind: could not read {}: {error}", app.config.capture_file.display());
            }

            if dropped_at.elapsed() > DROP_SPANS_EVERY {
                dropped_at = Instant::now();
                if let Err(error) = drop_old_spans(&app) {
                    eprintln!("rewind: could not drop old spans: {error}");
                }

                if let Err(error) = trim_if_long(&app) {
                    eprintln!("rewind: could not start {} over: {error}", app.config.capture_file.display());
                }
            }

            std::thread::sleep(READ_EVERY);
        }
    });
}

/// Where the capture file goes while Rewind reads the last of it.
fn moved_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".moved");
    PathBuf::from(name)
}

/// The file is worth starting over once it has grown past `max_bytes` and Rewind has read all of it.
fn worth_trimming(length: u64, read_to: u64, max_bytes: u64) -> bool {
    max_bytes > 0 && length >= max_bytes && read_to >= length
}

/// Moves the capture file aside so the preloads start a new one. They open it by name for every
/// line, so a line written as it moves lands in the old file, which `finish_moved` reads.
fn trim_if_long(app: &App) -> Result<()> {
    let path = &app.config.capture_file;
    let length = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let read_to = app.store.counter(OFFSET_COUNTER)?;
    if !worth_trimming(length, read_to, app.config.capture_max_bytes) {
        return Ok(());
    }

    fs::rename(path, moved_path(path))?;
    std::thread::sleep(MOVE_GRACE);
    finish_moved(app)?;
    eprintln!("rewind: started {} over after reading all {length} bytes of it", path.display());
    Ok(())
}

fn finish_moved(app: &App) -> Result<()> {
    let reset = || app.store.set_counter(OFFSET_COUNTER, 0);
    read_moved(&moved_path(&app.config.capture_file), |moved| read_from(app, moved), reset)
}

/// Reads what is left of a moved capture file, starts the offset over for the new file, and
/// deletes the moved one.
fn read_moved(moved: &Path, read_rest: impl FnOnce(&Path) -> Result<()>, reset: impl FnOnce() -> Result<()>) -> Result<()> {
    if !moved.exists() {
        return Ok(());
    }

    read_rest(moved)?;
    reset()?;
    Ok(fs::remove_file(moved)?)
}

fn start_at(length: u64, stored: u64) -> u64 {
    if length < stored {
        return 0;
    }

    stored
}

/// The complete lines in what was read, and how many bytes they take. A line still
/// being written has no newline yet and waits for the next read.
fn complete_lines(bytes: &[u8]) -> (Vec<&[u8]>, usize) {
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return (Vec::new(), 0);
    };
    let lines = bytes[..last_newline]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    (lines, last_newline + 1)
}

fn read_new(app: &App) -> Result<()> {
    read_from(app, &app.config.capture_file)
}

fn read_from(app: &App, path: &Path) -> Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    let stored = app.store.counter(OFFSET_COUNTER)?;
    let offset = start_at(length, stored);
    if offset == length {
        return Ok(());
    }

    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(offset))?;
    file.read_to_end(&mut bytes)?;
    let (lines, consumed) = complete_lines(&bytes);
    let mut spans = Vec::new();
    for line in lines {
        let Some(event) = serde_json::from_slice::<Value>(line).ok().and_then(|value| capture_event(&value)) else {
            eprintln!("rewind: skipped a line in the capture file that is not a capture");
            continue;
        };
        if Kind::parse(event.kind.as_deref()) == Kind::Function {
            spans.push(Span::from_event(event));
            continue;
        }

        store_event(app, &event);
    }

    app.spans.insert_all(&spans)?;
    app.store.set_counter(OFFSET_COUNTER, offset + consumed as u64)
}

/// Spans are kept for the newest runs only. Dropping older ones never changes a replay.
fn drop_old_spans(app: &App) -> Result<()> {
    let newest = app.store.runs(&app.config.entry, SPAN_RUNS_KEPT)?;
    if newest.len() < SPAN_RUNS_KEPT {
        return Ok(());
    }

    let cutoff = newest.last().map(|run| run.started_at_ms).unwrap_or(0);
    app.spans.delete_before(cutoff)?;
    Ok(())
}

fn status_of(failed: bool) -> Status {
    if failed {
        return Status::Error;
    }

    Status::Success
}

fn stored_input(kind: Kind, input: &Value) -> Value {
    if kind.is_request() {
        return outside::normalize_request(input);
    }

    input.clone()
}

/// One line of the capture file as an event, or none for a line that isn't a capture.
pub fn capture_event(line: &Value) -> Option<Event> {
    let text = |field: &str| line[field].as_str().map(str::to_string);
    let kind = Kind::parse(line["kind"].as_str());
    let name = text("name")?;
    if kind == Kind::Iii || Kind::of_id(&name) != kind {
        return None;
    }

    let failed = !line["error"].is_null();
    Some(Event {
        invocation_id: text("id")?,
        function_id: name,
        namespace: text("namespace").unwrap_or_else(|| "default".to_string()),
        status: status_of(failed),
        input: Some(stored_input(kind, &line["input"])),
        output: (!failed).then(|| line["output"].clone()),
        error: failed.then(|| line["error"].clone()),
        caller_worker: text("worker"),
        caller_function_id: text("function_id"),
        caller_invocation_id: text("invocation_id"),
        started_at_ms: line["started_at_ms"].as_u64().unwrap_or(0),
        duration_ms: line["duration_ms"].as_f64().unwrap_or(0.0),
        code_version: None,
        kind: Some(kind.as_str().to_string()),
        trace_id: text("trace_id"),
        span_id: text("span_id"),
    })
}

fn store_event(app: &App, event: &Event) {
    if let Err(error) = app.store.insert_event(event) {
        eprintln!("rewind: could not store capture {}: {error}", event.invocation_id);
        return;
    }

    if Kind::parse(event.kind.as_deref()) == Kind::HttpIn {
        app.changes.emit("run", &event.invocation_id);
        return;
    }

    // A run's page lists its calls around iii, so it hears when one lands after the run did.
    let Some(run_id) = event.caller_invocation_id.as_deref() else {
        return;
    };
    let is_run = app
        .store
        .event(run_id)
        .ok()
        .flatten()
        .is_some_and(|caller| caller.function_id == app.config.entry);
    // A run whose event is still waiting gets this capture with it, so only a later one is sent on its own.
    if is_run && !app.settling.call_arrived(run_id, Instant::now()) {
        app.changes.emit("run", run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_line_becomes_an_event_under_its_invocation() {
        let url = "http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2";
        let request = serde_json::json!({ "method": "GET", "url": url, "headers": { "accept": "*/*" }, "body": null });
        let line = serde_json::json!({
            "v": 1, "kind": "fetch", "id": "cap-1", "worker": "agent", "namespace": "default",
            "name": format!("fetch GET {url}"),
            "invocation_id": "run-1", "function_id": "agent::run",
            "trace_id": "0af7651916cd43dd8448eb211c80319c", "span_id": "b7ad6b7169203331",
            "started_at_ms": 1000u64, "duration_ms": 2.5,
            "input": request,
            "output": { "status": 200, "headers": {}, "body": "{\"holidays\":[]}" },
            "error": null,
        });
        let event = capture_event(&line).unwrap();
        assert_eq!(event.caller_invocation_id.as_deref(), Some("run-1"));
        assert_eq!(event.kind.as_deref(), Some("fetch"));
        assert_eq!(event.status, Status::Success);
        assert_eq!(event.trace_id.as_deref(), Some("0af7651916cd43dd8448eb211c80319c"));

        let mut failed = line.clone();
        failed["error"] = serde_json::json!({ "code": "FETCH_FAILED", "message": "fetch failed: connect ECONNREFUSED" });
        assert_eq!(capture_event(&failed).unwrap().status, Status::Error);

        let mut mislabelled = line.clone();
        mislabelled["kind"] = serde_json::json!("http_out");
        assert_eq!(capture_event(&mislabelled), None);
    }

    #[test]
    fn only_lines_with_a_newline_are_read() {
        let (lines, consumed) = complete_lines(b"{\"a\":1}\n\n{\"b\":2}\n{\"c\":");
        assert_eq!(lines, [b"{\"a\":1}".as_slice(), b"{\"b\":2}".as_slice()]);
        assert_eq!(consumed, 17);
        assert_eq!(complete_lines(b"{\"c\":"), (Vec::new(), 0));
    }

    #[test]
    fn a_file_shorter_than_where_reading_stopped_is_read_from_the_start() {
        assert_eq!(start_at(500, 120), 120);
        assert_eq!(start_at(80, 120), 0);
    }

    #[test]
    fn the_file_starts_over_only_once_it_is_long_and_read_to_its_end() {
        let mb = 1024 * 1024;
        assert!(worth_trimming(64 * mb, 64 * mb, 64 * mb));
        assert!(!worth_trimming(64 * mb, 64 * mb - 10, 64 * mb));
        assert!(!worth_trimming(mb, mb, 64 * mb));
        assert!(!worth_trimming(64 * mb, 64 * mb, 0));
        assert_eq!(moved_path(Path::new("/data/captures.jsonl")), Path::new("/data/captures.jsonl.moved"));
    }

    #[test]
    fn a_line_written_while_the_file_moves_is_read_and_later_lines_start_a_new_file() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("rewind-captures-move-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("captures.jsonl");
        fs::write(&path, "{\"a\":1}\n").unwrap();
        let mut writing = fs::OpenOptions::new().append(true).open(&path).unwrap();

        fs::rename(&path, moved_path(&path)).unwrap();
        writing.write_all(b"{\"b\":2}\n").unwrap();
        fs::OpenOptions::new().append(true).create(true).open(&path).unwrap().write_all(b"{\"c\":3}\n").unwrap();

        let mut read = String::new();
        let mut reset = false;
        let moved = moved_path(&path);
        let read_rest = |moved: &Path| -> Result<()> {
            read = fs::read_to_string(moved)?;
            Ok(())
        };
        read_moved(&moved, read_rest, || {
            reset = true;
            Ok(())
        })
        .unwrap();
        assert_eq!(read, "{\"a\":1}\n{\"b\":2}\n");
        assert!(reset);
        assert!(!moved.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"c\":3}\n");
        let nothing = || crate::error::Error::Internal("nothing to read".into());
        assert!(read_moved(&moved, |_| Err(nothing()), || Ok(())).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }
}
