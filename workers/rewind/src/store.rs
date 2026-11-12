//! SQLite: one row per observed call, the forks, and which functions a person
//! turned recording on or off for. JSON values are stored as text.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::{
    error::{Error, Result},
    runs::NOT_ROOTS,
    forks::ForkRecord,
    workers::WorkerChange,
};

const SCHEMA: &str = "
create table if not exists events (
  invocation_id        text primary key,
  function_id          text not null,
  namespace            text not null,
  status               text not null,
  input                text,
  output               text,
  error                text,
  caller_worker        text,
  caller_function_id   text,
  caller_invocation_id text,
  started_at_ms        integer not null,
  duration_ms          double not null,
  code_version         text,
  kind                 text,
  trace_id             text,
  span_id              text
);
create index if not exists events_by_caller on events (caller_invocation_id);
create index if not exists events_by_function on events (function_id, namespace, started_at_ms);

create table if not exists forks (
  fork_id       text primary key,
  run_id        text not null,
  body          text not null,
  created_at_ms integer not null
);
create index if not exists forks_by_run on forks (run_id);

create table if not exists record_toggles (
  function_id text primary key,
  enabled     integer not null
);

create table if not exists counters (
  name  text primary key,
  value integer not null
);

create table if not exists worker_changes (
  at_ms     integer not null,
  worker    text not null,
  worker_id text not null,
  event     text not null
);
create index if not exists worker_changes_by_time on worker_changes (at_ms);
";

/// How an observed call or a capture ended. The engine reports `success` or `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Success,
    Error,
}

impl Status {
    /// Anything but `error` counts as success.
    pub fn parse(text: &str) -> Self {
        if text == "error" {
            return Status::Error;
        }

        Status::Success
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Success => "success",
            Status::Error => "error",
        }
    }
}

impl From<&str> for Status {
    fn from(text: &str) -> Self {
        Status::parse(text)
    }
}

/// One recorded call, as the events table stores it: an iii call the observers saw, or a call
/// around iii a preload captured. A run is the root event and the events whose caller it was.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub invocation_id: String,
    pub function_id: String,
    pub namespace: String,
    pub status: Status,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub error: Option<Value>,
    pub caller_worker: Option<String>,
    pub caller_function_id: Option<String>,
    pub caller_invocation_id: Option<String>,
    pub started_at_ms: u64,
    pub duration_ms: f64,
    /// The version of the code under test when Rewind recorded a run. Other calls leave it out.
    pub code_version: Option<String>,
    /// What a preload captured around iii, such as `fetch`, or none for an observed iii call.
    pub kind: Option<String>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
}

/// One connection writes, and queries take a connection of their own from `readers`, so a slow
/// runs list never makes the recorder's writer wait, and a long write never delays a page.
pub struct Store {
    writer: Mutex<Connection>,
    readers: Readers,
    #[cfg(test)]
    _scratch: Option<Scratch>,
}

// The page asks for status, functions, runs and lost runs at once, so four cover a normal refresh.
const READERS_KEPT: usize = 4;

/// Read connections to the store's file. A query takes an idle one, or opens another when every
/// one is busy, so queries never wait for each other either.
struct Readers {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl Readers {
    fn take(&self) -> rusqlite::Result<Connection> {
        if let Some(conn) = self.idle.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pop() {
            return Ok(conn);
        }

        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.execute_batch("pragma query_only = true")?;
        Ok(conn)
    }

    fn give_back(&self, conn: Connection) {
        let mut idle = self.idle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if idle.len() < READERS_KEPT {
            idle.push(conn);
        }
    }
}

/// Which start times a runs list covers: before `before_ms`, not counting it, and from
/// `since_ms` on. Passing the oldest start of one page as `before_ms` gets the next page.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Window {
    pub before_ms: Option<u64>,
    pub since_ms: Option<u64>,
}

impl Window {
    fn bounds(self) -> (i64, i64) {
        let before = self.before_ms.map(|ms| ms as i64).unwrap_or(i64::MAX);
        (before, self.since_ms.unwrap_or(0) as i64)
    }
}

const DELETE_CHUNK: usize = 5_000;

/// How many rows of each kind `delete_before` dropped.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Deleted {
    pub events: usize,
    pub forks: usize,
    pub worker_changes: usize,
}

fn json_text(value: &Option<Value>) -> Option<String> {
    value.as_ref().map(Value::to_string)
}

/// A JSON column as a value. Text that is not JSON reads as empty, so one bad column never hides
/// the rest of the row, and Rewind says which column it was.
pub fn json_column(row: &Row, index: usize) -> rusqlite::Result<Option<Value>> {
    let Some(text) = row.get::<_, Option<String>>(index)? else {
        return Ok(None);
    };

    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let column = row.as_ref().column_name(index).unwrap_or("?");
            eprintln!("rewind: a stored {column} is not JSON, so it reads as empty: {error}");
            Ok(None)
        }
    }
}

fn fork_from_body(fork_id: &str, body: &str) -> Result<ForkRecord> {
    serde_json::from_str(body).map_err(|error| Error::StoreData(format!("fork {fork_id} could not be read: {error}")))
}

const EVENT_COLUMNS: &str = "invocation_id, function_id, namespace, status, input, output, error, \
     caller_worker, caller_function_id, caller_invocation_id, started_at_ms, duration_ms, code_version, \
     kind, trace_id, span_id";

fn event_from_row(row: &Row) -> rusqlite::Result<Event> {
    Ok(Event {
        invocation_id: row.get(0)?,
        function_id: row.get(1)?,
        namespace: row.get(2)?,
        status: Status::parse(&row.get::<_, String>(3)?),
        input: json_column(row, 4)?,
        output: json_column(row, 5)?,
        error: json_column(row, 6)?,
        caller_worker: row.get(7)?,
        caller_function_id: row.get(8)?,
        caller_invocation_id: row.get(9)?,
        started_at_ms: row.get::<_, i64>(10)? as u64,
        duration_ms: row.get(11)?,
        code_version: row.get(12)?,
        kind: row.get(13)?,
        trace_id: row.get(14)?,
        span_id: row.get(15)?,
    })
}

/// Leaving out Rewind's and the engine's functions here, instead of after the query, keeps a page
/// of roots full. Left to itself, SQLite picks the index on kind and sorts every capture.
fn uncalled_query() -> String {
    let not_ours: Vec<String> = NOT_ROOTS
        .iter()
        .map(|prefix| format!("and function_id not like '{prefix}%'"))
        .collect();
    format!(
        "select {EVENT_COLUMNS} from events indexed by events_without_caller \
         where caller_invocation_id is null and namespace = 'default' \
         and (kind is null or kind = 'http_in') {} and (?4 is null or function_id = ?4) \
         and started_at_ms < ?2 and started_at_ms >= ?3 order by started_at_ms desc limit ?1",
        not_ours.join(" ")
    )
}

const ADDED_COLUMNS: [&str; 4] = ["code_version", "kind", "trace_id", "span_id"];

// A database made by an older Rewind is missing the columns added since.
fn add_columns(conn: &Connection) -> rusqlite::Result<()> {
    for column in ADDED_COLUMNS {
        let has_column = conn
            .prepare("select 1 from pragma_table_info('events') where name = ?1")?
            .exists(params![column])?;
        if !has_column {
            conn.execute(&format!("alter table events add column {column} text"), [])?;
        }
    }

    conn.execute("create index if not exists events_by_kind on events (kind, started_at_ms)", [])?;
    // Only roots have no caller, so listing them never reads the thousands of calls a burst makes.
    conn.execute(
        "create index if not exists events_without_caller on events (started_at_ms) where caller_invocation_id is null",
        [],
    )?;
    Ok(())
}

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Readers no longer wait on a writer with WAL, and `normal` sync skips an fsync per commit, which
/// can lose the last commits on a power cut but never corrupts the file.
pub fn tune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("pragma journal_mode = wal; pragma synchronous = normal;")?;
    conn.busy_timeout(BUSY_TIMEOUT)
}

/// A database file for one test, deleted with its `-wal` and `-shm` when the store is dropped.
#[cfg(test)]
struct Scratch(PathBuf);

#[cfg(test)]
impl Drop for Scratch {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|error| Error::StoreData(format!("{}: {error}", dir.display())))?;
        }

        let conn = Connection::open(path)?;
        tune(&conn)?;
        conn.execute_batch(SCHEMA)?;
        add_columns(&conn)?;
        Ok(Self {
            writer: Mutex::new(conn),
            readers: Readers {
                path: path.to_path_buf(),
                idle: Mutex::default(),
            },
            #[cfg(test)]
            _scratch: None,
        })
    }

    /// A store in a file of its own, so its readers see what its writer commits the way they do
    /// in Rewind. An in-memory database would give each connection a database of its own.
    #[cfg(test)]
    pub fn temporary() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!("rewind-store-{}-{}.sqlite", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let path = std::env::temp_dir().join(name);
        let scratch = Scratch(path.clone());
        Self {
            _scratch: Some(scratch),
            ..Self::open(&path).unwrap()
        }
    }

    fn write<T>(&self, work: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(work(&conn)?)
    }

    fn read<T>(&self, work: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.readers.take()?;
        let result = work(&conn);
        self.readers.give_back(conn);
        Ok(result?)
    }

    pub fn insert_event(&self, event: &Event) -> Result<()> {
        self.insert_events(std::slice::from_ref(event))
    }

    /// Stores every event in one transaction, so a burst of calls costs one commit.
    pub fn insert_events(&self, events: &[Event]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }

        self.write(|conn| {
            let transaction = conn.unchecked_transaction()?;
            {
                let mut statement = transaction.prepare_cached(&format!(
                    "insert or replace into events ({EVENT_COLUMNS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                ))?;
                for event in events {
                    statement.execute(params![
                        event.invocation_id,
                        event.function_id,
                        event.namespace,
                        event.status.as_str(),
                        json_text(&event.input),
                        json_text(&event.output),
                        json_text(&event.error),
                        event.caller_worker,
                        event.caller_function_id,
                        event.caller_invocation_id,
                        event.started_at_ms as i64,
                        event.duration_ms,
                        event.code_version,
                        event.kind,
                        event.trace_id,
                        event.span_id,
                    ])?;
                }
            }
            transaction.commit()
        })
    }

    pub fn set_span_id(&self, invocation_id: &str, span_id: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute("update events set span_id = ?2 where invocation_id = ?1", params![invocation_id, span_id])?;
            Ok(())
        })
    }

    pub fn insert_worker_change(&self, change: &WorkerChange) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "insert into worker_changes (at_ms, worker, worker_id, event) values (?1, ?2, ?3, ?4)",
                params![change.at_ms as i64, change.worker, change.worker_id, change.event],
            )?;
            Ok(())
        })
    }

    /// Workers that connected or disconnected from `from_ms` to `to_ms`, both included, oldest first.
    pub fn worker_changes_between(&self, from_ms: u64, to_ms: u64) -> Result<Vec<WorkerChange>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(
                "select at_ms, worker, worker_id, event from worker_changes \
                 where at_ms >= ?1 and at_ms <= ?2 order by at_ms, rowid",
            )?;
            let rows = statement.query_map(params![from_ms as i64, to_ms as i64], |row| {
                Ok(WorkerChange {
                    at_ms: row.get::<_, i64>(0)? as u64,
                    worker: row.get(1)?,
                    worker_id: row.get(2)?,
                    event: row.get(3)?,
                })
            })?;
            rows.collect()
        })
    }

    pub fn counter(&self, name: &str) -> Result<u64> {
        self.read(|conn| {
            conn.query_row("select value from counters where name = ?1", params![name], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map(|value| value.unwrap_or(0) as u64)
        })
    }

    pub fn set_counter(&self, name: &str, value: u64) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "insert into counters (name, value) values (?1, ?2) on conflict (name) do update set value = ?2",
                params![name, value as i64],
            )?;
            Ok(())
        })
    }

    pub fn event(&self, invocation_id: &str) -> Result<Option<Event>> {
        self.read(|conn| {
            conn.query_row(
                &format!("select {EVENT_COLUMNS} from events where invocation_id = ?1"),
                params![invocation_id],
                event_from_row,
            )
            .optional()
        })
    }

    /// Every event whose caller was this invocation, in no particular order.
    pub fn children(&self, invocation_id: &str) -> Result<Vec<Event>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(&format!(
                "select {EVENT_COLUMNS} from events where caller_invocation_id = ?1"
            ))?;
            let rows = statement.query_map(params![invocation_id], event_from_row)?;
            rows.collect()
        })
    }

    /// The entry function's events in `default`, newest first.
    pub fn runs(&self, entry: &str, limit: usize) -> Result<Vec<Event>> {
        self.runs_in(entry, Window::default(), limit)
    }

    /// The entry function's events in `default` that started inside `window`, newest first.
    pub fn runs_in(&self, entry: &str, window: Window, limit: usize) -> Result<Vec<Event>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(&format!(
                "select {EVENT_COLUMNS} from events where function_id = ?1 and namespace = 'default' \
                 and started_at_ms < ?3 and started_at_ms >= ?4 order by started_at_ms desc limit ?2"
            ))?;
            let (before, since) = window.bounds();
            let rows = statement.query_map(params![entry, limit as i64, before, since], event_from_row)?;
            rows.collect()
        })
    }

    /// Requests that arrived at a worker's own HTTP server, newest first. Each is the root of a run.
    pub fn inbound_runs(&self, window: Window, limit: usize) -> Result<Vec<Event>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(&format!(
                "select {EVENT_COLUMNS} from events where kind = 'http_in' \
                 and started_at_ms < ?2 and started_at_ms >= ?3 order by started_at_ms desc limit ?1"
            ))?;
            let (before, since) = window.bounds();
            let rows = statement.query_map(params![limit as i64, before, since], event_from_row)?;
            rows.collect()
        })
    }

    /// Calls in `default` that nothing recorded called, newest first, optionally of one function:
    /// calls made from outside, such as with `iii trigger`, and requests to a worker's own server.
    pub fn uncalled_in(&self, function_id: Option<&str>, window: Window, limit: usize) -> Result<Vec<Event>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(&uncalled_query())?;
            let (before, since) = window.bounds();
            let rows = statement.query_map(params![limit as i64, before, since, function_id], event_from_row)?;
            rows.collect()
        })
    }

    pub fn count_inbound_runs(&self) -> Result<u64> {
        self.read(|conn| {
            conn.query_row("select count(*) from events where kind = 'http_in'", [], |row| row.get::<_, i64>(0))
                .map(|count| count as u64)
        })
    }

    pub fn count_runs(&self, entry: &str) -> Result<u64> {
        self.read(|conn| {
            conn.query_row(
                "select count(*) from events where function_id = ?1 and namespace = 'default'",
                params![entry],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u64)
        })
    }

    pub fn has_recorded(&self, function_id: &str) -> Result<bool> {
        self.read(|conn| {
            conn.query_row(
                "select exists (select 1 from events where function_id = ?1 and namespace = 'default')",
                params![function_id],
                |row| row.get(0),
            )
        })
    }

    /// The newest successful call to `function_id` in `default` that another run of the
    /// same entry function made, or none when no other run ever got one through.
    pub fn newest_success_elsewhere(&self, function_id: &str, run_id: &str) -> Result<Option<Event>> {
        self.read(|conn| {
            conn.query_row(
                &format!(
                    "select {EVENT_COLUMNS} from events \
                     where function_id = ?1 and namespace = 'default' and status = 'success' \
                     and caller_invocation_id != ?2 \
                     and caller_function_id = (select function_id from events where invocation_id = ?2) \
                     order by started_at_ms desc limit 1"
                ),
                params![function_id, run_id],
                event_from_row,
            )
            .optional()
        })
    }

    /// The runs that made a call whose invocation id starts with `prefix`, ignoring case.
    pub fn runs_with_call_prefix(&self, prefix: &str) -> Result<HashSet<String>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached(
                "select distinct caller_invocation_id from events \
                 where caller_invocation_id is not null and substr(lower(invocation_id), 1, length(?1)) = ?1",
            )?;
            let rows = statement.query_map(params![prefix.to_lowercase()], |row| row.get(0))?;
            rows.collect()
        })
    }

    fn next_number(&self, counter: &str) -> Result<u64> {
        self.write(|conn| {
            conn.execute(
                "insert into counters (name, value) values (?1, 1) \
                 on conflict (name) do update set value = value + 1",
                params![counter],
            )?;
            conn.query_row("select value from counters where name = ?1", params![counter], |row| {
                row.get::<_, i64>(0)
            })
            .map(|value| value as u64)
        })
    }

    pub fn next_fork_number(&self) -> Result<u64> {
        self.next_number("fork")
    }

    pub fn next_check_number(&self) -> Result<u64> {
        self.next_number("check")
    }

    pub fn put_fork(&self, fork: &ForkRecord) -> Result<()> {
        let body = serde_json::to_string(fork).map_err(|error| Error::StoreData(error.to_string()))?;
        self.write(|conn| {
            conn.execute(
                "insert or replace into forks (fork_id, run_id, body, created_at_ms) values (?1, ?2, ?3, ?4)",
                params![fork.fork_id, fork.run_id, body, fork.created_at_ms as i64],
            )?;
            Ok(())
        })
    }

    /// The fork, none when there is no such fork, or an error when its stored body does not parse.
    pub fn fork(&self, fork_id: &str) -> Result<Option<ForkRecord>> {
        let body: Option<String> = self.read(|conn| {
            conn.query_row(
                "select body from forks where fork_id = ?1",
                params![fork_id],
                |row| row.get(0),
            )
            .optional()
        })?;
        body.map(|body| fork_from_body(fork_id, &body)).transpose()
    }

    /// The run's forks, oldest first. A fork whose body does not parse is left out, and said so.
    pub fn forks_of_run(&self, run_id: &str) -> Result<Vec<ForkRecord>> {
        let rows: Vec<(String, String)> = self.read(|conn| {
            let mut statement = conn
                .prepare_cached("select fork_id, body from forks where run_id = ?1 order by created_at_ms")?;
            let rows = statement.query_map(params![run_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        })?;
        let readable = rows.iter().filter_map(|(fork_id, body)| {
            fork_from_body(fork_id, body)
                .inspect_err(|error| eprintln!("rewind: left out of run {run_id}'s forks: {error}"))
                .ok()
        });
        Ok(readable.collect())
    }

    pub fn count_forks(&self) -> Result<u64> {
        self.read(|conn| {
            conn.query_row("select count(*) from forks", [], |row| row.get::<_, i64>(0))
                .map(|count| count as u64)
        })
    }

    pub fn delete_fork(&self, fork_id: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute("delete from forks where fork_id = ?1", params![fork_id])?;
            Ok(())
        })
    }

    /// When the `count`th newest run of `entry` started, or none when there are fewer runs.
    pub fn start_of_nth_newest_run(&self, entry: &str, count: usize) -> Result<Option<u64>> {
        if count == 0 {
            return Ok(None);
        }

        self.read(|conn| {
            conn.query_row(
                "select started_at_ms from events where function_id = ?1 and namespace = 'default' \
                 order by started_at_ms desc limit 1 offset ?2",
                params![entry, (count - 1) as i64],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|start| start.map(|ms| ms as u64))
        })
    }

    /// Drops every call that started before `cutoff_ms`, the worker changes from before then, and
    /// each fork made before then or whose run is gone. Calls go a chunk at a time, so a replay
    /// waiting on the store never waits long.
    pub fn delete_before(&self, cutoff_ms: u64) -> Result<Deleted> {
        let cutoff = cutoff_ms as i64;
        let mut events = 0;
        loop {
            let gone = self.write(|conn| {
                conn.execute(
                    "delete from events where rowid in \
                     (select rowid from events where started_at_ms < ?1 limit ?2)",
                    params![cutoff, DELETE_CHUNK as i64],
                )
            })?;
            events += gone;
            if gone < DELETE_CHUNK {
                break;
            }
        }

        let forks = self.write(|conn| {
            conn.execute(
                "delete from forks where created_at_ms < ?1 \
                 or not exists (select 1 from events where invocation_id = forks.run_id)",
                params![cutoff],
            )
        })?;
        let worker_changes = self.write(|conn| conn.execute("delete from worker_changes where at_ms < ?1", params![cutoff]))?;
        Ok(Deleted { events, forks, worker_changes })
    }

    pub fn toggles(&self) -> Result<HashMap<String, bool>> {
        self.read(|conn| {
            let mut statement = conn.prepare_cached("select function_id, enabled from record_toggles")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })?;
            rows.collect()
        })
    }

    pub fn set_toggle(&self, function_id: &str, enabled: bool) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "insert or replace into record_toggles (function_id, enabled) values (?1, ?2)",
                params![function_id, enabled as i64],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(id: &str, caller: Option<&str>) -> Event {
        Event {
            invocation_id: id.into(),
            function_id: "clock::now".into(),
            namespace: "default".into(),
            status: "success".into(),
            input: Some(json!({})),
            output: Some(json!({ "now": "2026-10-27T15:02:11-05:00" })),
            error: None,
            caller_worker: Some("agent".into()),
            caller_function_id: Some("agent::run".into()),
            caller_invocation_id: caller.map(str::to_string),
            started_at_ms: 1,
            duration_ms: 2.5,
            code_version: None,
            kind: None,
            trace_id: None,
            span_id: None,
        }
    }

    #[test]
    fn an_event_comes_back_as_it_went_in() {
        let store = Store::temporary();
        let stored = event("a", Some("run-1"));
        store.insert_event(&stored).unwrap();
        assert_eq!(store.event("a").unwrap(), Some(stored.clone()));
        assert_eq!(store.children("run-1").unwrap(), vec![stored]);
    }

    #[test]
    fn events_stored_together_come_back_like_ones_stored_alone() {
        let store = Store::temporary();
        let batch = [event("a", Some("run-1")), event("b", Some("run-1")), event("c", None)];
        store.insert_events(&batch).unwrap();
        store.insert_events(&[]).unwrap();
        assert_eq!(store.event("c").unwrap(), Some(batch[2].clone()));
        assert_eq!(store.children("run-1").unwrap().len(), 2);
    }

    #[test]
    fn a_file_store_uses_wal() {
        let store = Store::temporary();
        let mode: String = store.read(|conn| conn.query_row("pragma journal_mode", [], |row| row.get(0))).unwrap();
        assert_eq!(mode, "wal");
    }

    #[test]
    fn a_query_runs_while_a_write_is_under_way_and_sees_it_once_it_commits() {
        let store = Store::temporary();
        store
            .write(|conn| {
                let transaction = conn.unchecked_transaction()?;
                transaction.execute("insert into counters (name, value) values ('fork', 7)", [])?;
                assert_eq!(store.counter("fork").unwrap(), 0);
                transaction.commit()
            })
            .unwrap();
        assert_eq!(store.counter("fork").unwrap(), 7);
    }

    #[test]
    fn a_write_commits_while_a_query_is_reading() {
        let store = Store::temporary();
        store.insert_event(&event("a", Some("run-1"))).unwrap();
        let seen = store
            .read(|conn| {
                let mut statement = conn.prepare("select invocation_id from events")?;
                let mut rows = statement.query([])?;
                let first: String = rows.next()?.unwrap().get(0)?;
                store.insert_event(&event("b", Some("run-1"))).unwrap();
                Ok(first)
            })
            .unwrap();
        assert_eq!(seen, "a");
        assert_eq!(store.children("run-1").unwrap().len(), 2);
    }

    #[test]
    fn a_query_cannot_write() {
        let store = Store::temporary();
        let refused = store.read(|conn| conn.execute("insert into counters (name, value) values ('fork', 1)", []));
        assert!(refused.is_err());
    }

    #[test]
    fn a_run_keeps_its_code_version() {
        let store = Store::temporary();
        let run = Event {
            code_version: Some("3f2a9c10aaaa".into()),
            ..event("run-1", None)
        };
        store.insert_event(&run).unwrap();
        assert_eq!(store.event("run-1").unwrap().unwrap().code_version.as_deref(), Some("3f2a9c10aaaa"));
    }

    #[test]
    fn an_older_database_gets_the_columns_added_since() {
        let path = std::env::temp_dir().join(format!("rewind-store-older-{}.sqlite", std::process::id()));
        let _scratch = Scratch(path.clone());
        let added = ",\n  code_version         text,\n  kind                 text,\n  trace_id             text,\n  span_id              text";
        assert!(SCHEMA.contains(added));
        Connection::open(&path).unwrap().execute_batch(&SCHEMA.replace(added, "")).unwrap();
        drop(Store::open(&path).unwrap());
        let store = Store::open(&path).unwrap();
        let traced = Event {
            kind: Some("fetch".into()),
            trace_id: Some("0af7651916cd43dd8448eb211c80319c".into()),
            ..event("a", None)
        };
        store.insert_event(&traced).unwrap();
        assert_eq!(store.event("a").unwrap(), Some(traced));
    }

    #[test]
    fn a_counter_starts_at_zero_and_keeps_what_was_set() {
        let store = Store::temporary();
        assert_eq!(store.counter("capture_offset").unwrap(), 0);
        store.set_counter("capture_offset", 120).unwrap();
        store.set_counter("capture_offset", 240).unwrap();
        assert_eq!(store.counter("capture_offset").unwrap(), 240);
    }

    #[test]
    fn a_call_id_prefix_finds_the_run_that_made_it() {
        let store = Store::temporary();
        store.insert_event(&event("9C41aa-call", Some("run-1"))).unwrap();
        store.insert_event(&event("9c42bb-call", Some("run-2"))).unwrap();
        store.insert_event(&event("run-3", None)).unwrap();
        assert_eq!(store.runs_with_call_prefix("9c41").unwrap(), HashSet::from(["run-1".to_string()]));
        assert_eq!(store.runs_with_call_prefix("9C4").unwrap().len(), 2);
        assert!(store.runs_with_call_prefix("run-3").unwrap().is_empty());
    }

    fn send(id: &str, run_id: &str, started_at_ms: u64, status: &str) -> Event {
        Event {
            function_id: "email::send".into(),
            status: status.into(),
            output: Some(json!({ "status": "accepted", "id": id })),
            started_at_ms,
            ..event(id, Some(run_id))
        }
    }

    fn agent_run(id: &str) -> Event {
        Event {
            function_id: "agent::run".into(),
            caller_function_id: Some("traffic::burst".into()),
            ..event(id, Some("burst-1"))
        }
    }

    #[test]
    fn the_newest_success_from_another_run_is_found() {
        let store = Store::temporary();
        for run in ["run-1", "run-2", "run-3", "run-4"] {
            store.insert_event(&agent_run(run)).unwrap();
        }

        store.insert_event(&send("older", "run-2", 10, "success")).unwrap();
        store.insert_event(&send("newer", "run-3", 20, "success")).unwrap();
        store.insert_event(&send("failed", "run-4", 30, "error")).unwrap();
        store.insert_event(&send("own", "run-1", 40, "success")).unwrap();
        let mut not_a_run = send("by-a-tool", "tool-call-1", 50, "success");
        not_a_run.caller_function_id = Some("calendar::find-slot".into());
        store.insert_event(&not_a_run).unwrap();

        let found = store.newest_success_elsewhere("email::send", "run-1").unwrap().unwrap();
        assert_eq!(found.invocation_id, "newer");
        assert_eq!(found.caller_invocation_id.as_deref(), Some("run-3"));
    }

    #[test]
    fn a_function_no_other_run_got_through_has_nothing_to_find() {
        let store = Store::temporary();
        store.insert_event(&agent_run("run-1")).unwrap();
        store.insert_event(&agent_run("run-2")).unwrap();
        store.insert_event(&send("own", "run-1", 10, "success")).unwrap();
        store.insert_event(&send("failed", "run-2", 20, "error")).unwrap();
        assert_eq!(store.newest_success_elsewhere("email::send", "run-1").unwrap(), None);
        assert_eq!(store.newest_success_elsewhere("email::send", "no-such-run").unwrap(), None);
    }

    #[test]
    fn runs_page_by_start_time() {
        let store = Store::temporary();
        for (id, started_at_ms) in [("r1", 100), ("r2", 200), ("r3", 300), ("r4", 400)] {
            store
                .insert_event(&Event {
                    started_at_ms,
                    ..agent_run(id)
                })
                .unwrap();
        }

        let ids = |window: Window, limit: usize| -> Vec<String> {
            store.runs_in("agent::run", window, limit).unwrap().into_iter().map(|run| run.invocation_id).collect()
        };
        assert_eq!(ids(Window::default(), 2), ["r4", "r3"]);
        assert_eq!(ids(Window { before_ms: Some(300), since_ms: None }, 2), ["r2", "r1"]);
        assert_eq!(ids(Window { before_ms: None, since_ms: Some(200) }, 10), ["r4", "r3", "r2"]);
        assert_eq!(ids(Window { before_ms: Some(400), since_ms: Some(200) }, 10), ["r3", "r2"]);
    }

    #[test]
    fn calls_nothing_recorded_called_are_found_newest_first_and_of_one_function() {
        let store = Store::temporary();
        let burst = Event {
            function_id: "traffic::burst".into(),
            caller_worker: None,
            caller_function_id: None,
            started_at_ms: 10,
            ..event("burst-1", None)
        };
        let triggered = Event {
            function_id: "calendar::find-slot".into(),
            started_at_ms: 20,
            ..event("slot-1", None)
        };
        let request = Event {
            function_id: "http_in GET http://127.0.0.1:49335/holidays".into(),
            kind: Some("http_in".into()),
            started_at_ms: 30,
            ..event("in-1", None)
        };
        let fetch = Event {
            function_id: "fetch GET http://x/".into(),
            kind: Some("fetch".into()),
            started_at_ms: 40,
            ..event("fetch-1", None)
        };
        let own = Event {
            function_id: "rewind::runs".into(),
            started_at_ms: 50,
            ..event("own-1", None)
        };
        for stored in [burst, triggered, request, fetch, own, agent_run("run-1"), event("clock-1", Some("run-1"))] {
            store.insert_event(&stored).unwrap();
        }

        let ids = |function_id: Option<&str>| -> Vec<String> {
            let found = store.uncalled_in(function_id, Window::default(), 10).unwrap();
            found.into_iter().map(|root| root.invocation_id).collect()
        };
        assert_eq!(ids(None), ["in-1", "slot-1", "burst-1"]);
        assert_eq!(ids(Some("calendar::find-slot")), ["slot-1"]);
    }

    #[test]
    fn listing_roots_reads_the_index_of_calls_without_a_caller_and_never_sorts() {
        let store = Store::temporary();
        let plan: Vec<String> = store
            .read(|conn| {
                let mut statement = conn.prepare(&format!("explain query plan {}", uncalled_query()))?;
                let rows = statement.query_map(params![10, i64::MAX, 0, Option::<String>::None], |row| row.get::<_, String>(3))?;
                rows.collect()
            })
            .unwrap();
        let plan = plan.join("; ");
        assert!(plan.contains("events_without_caller"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }

    fn fork_row(store: &Store, fork_id: &str, run_id: &str, created_at_ms: u64) {
        store
            .write(|conn| {
                conn.execute(
                    "insert into forks (fork_id, run_id, body, created_at_ms) values (?1, ?2, '{}', ?3)",
                    params![fork_id, run_id, created_at_ms as i64],
                )
            })
            .unwrap();
    }

    fn change(at_ms: u64) -> WorkerChange {
        WorkerChange {
            at_ms,
            worker: "tools".into(),
            worker_id: "w".into(),
            event: "connected".into(),
        }
    }

    #[test]
    fn the_nth_newest_run_says_where_the_kept_runs_begin() {
        let store = Store::temporary();
        for (id, started_at_ms) in [("r1", 100), ("r2", 200), ("r3", 300)] {
            store.insert_event(&Event { started_at_ms, ..agent_run(id) }).unwrap();
        }

        assert_eq!(store.start_of_nth_newest_run("agent::run", 1).unwrap(), Some(300));
        assert_eq!(store.start_of_nth_newest_run("agent::run", 2).unwrap(), Some(200));
        assert_eq!(store.start_of_nth_newest_run("agent::run", 4).unwrap(), None);
        assert_eq!(store.start_of_nth_newest_run("agent::run", 0).unwrap(), None);
    }

    #[test]
    fn deleting_before_a_time_drops_old_calls_their_forks_and_old_worker_changes() {
        let store = Store::temporary();
        store.insert_event(&Event { started_at_ms: 100, ..agent_run("old-run") }).unwrap();
        store.insert_event(&send("old-send", "old-run", 110, "success")).unwrap();
        store.insert_event(&Event { started_at_ms: 300, ..agent_run("new-run") }).unwrap();
        store.insert_event(&send("new-send", "new-run", 310, "success")).unwrap();
        fork_row(&store, "f1", "old-run", 400);
        fork_row(&store, "f2", "new-run", 150);
        fork_row(&store, "f3", "new-run", 400);
        store.insert_worker_change(&change(100)).unwrap();
        store.insert_worker_change(&change(300)).unwrap();

        let deleted = store.delete_before(200).unwrap();
        assert_eq!(deleted, Deleted { events: 2, forks: 2, worker_changes: 1 });
        assert_eq!(store.event("old-run").unwrap(), None);
        assert!(store.event("new-send").unwrap().is_some());
        let kept: Vec<String> = store
            .read(|conn| conn.prepare("select fork_id from forks")?.query_map([], |row| row.get(0))?.collect())
            .unwrap();
        assert_eq!(kept, ["f3"]);
        assert_eq!(store.worker_changes_between(0, 1_000).unwrap(), [change(300)]);
        assert_eq!(store.delete_before(200).unwrap(), Deleted::default());
    }

    #[test]
    fn deleting_goes_on_past_one_chunk() {
        let store = Store::temporary();
        let old: Vec<Event> = (0..DELETE_CHUNK + 3).map(|n| event(&format!("old-{n}"), Some("run-1"))).collect();
        store.insert_events(&old).unwrap();
        store.insert_event(&Event { started_at_ms: 50, ..event("kept", Some("run-1")) }).unwrap();
        assert_eq!(store.delete_before(10).unwrap().events, DELETE_CHUNK + 3);
        assert_eq!(store.children("run-1").unwrap().len(), 1);
    }

    #[test]
    fn a_fork_whose_body_does_not_parse_is_an_error_and_is_left_out_of_its_runs_forks() {
        let store = Store::temporary();
        fork_row(&store, "f1", "run-1", 10);
        assert_eq!(store.fork("f1").unwrap_err().code(), "REWIND_STORE");
        assert!(store.fork("f2").unwrap().is_none());
        assert!(store.forks_of_run("run-1").unwrap().is_empty());
    }

    #[test]
    fn a_column_that_is_not_json_reads_as_empty_and_the_row_still_reads() {
        let store = Store::temporary();
        store.insert_event(&event("a", Some("run-1"))).unwrap();
        store
            .write(|conn| conn.execute("update events set output = '{not json' where invocation_id = 'a'", []))
            .unwrap();
        let read = store.event("a").unwrap().unwrap();
        assert_eq!(read.output, None);
        assert_eq!(read.input, Some(json!({})));
    }

    #[test]
    fn fork_and_check_numbers_count_up_on_their_own() {
        let store = Store::temporary();
        assert_eq!(store.next_fork_number().unwrap(), 1);
        assert_eq!(store.next_fork_number().unwrap(), 2);
        assert_eq!(store.next_check_number().unwrap(), 1);
    }
}
