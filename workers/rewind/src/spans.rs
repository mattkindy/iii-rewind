//! Function spans from the preloads, in a SQLite file of their own with its own connection,
//! so a burst of span writes never holds the lock the runs list and replays wait on. Only
//! `rewind::spans` reads them, and they are kept for the newest runs only.

use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::{
    error::{Error, Result},
    store::{self, Event, Status, json_column},
};

const SCHEMA: &str = "
create table if not exists spans (
  id            text primary key,
  invocation_id text,
  function_id   text,
  name          text not null,
  worker        text,
  trace_id      text,
  span_id       text,
  started_at_ms integer not null,
  duration_ms   double not null,
  status        text not null,
  input         text,
  output        text,
  error         text
);
create index if not exists spans_by_invocation on spans (invocation_id, started_at_ms);
create index if not exists spans_by_trace on spans (trace_id);
create index if not exists spans_by_start on spans (started_at_ms);
";

const COLUMNS: &str =
    "id, invocation_id, function_id, name, worker, trace_id, span_id, started_at_ms, duration_ms, status, input, output, error";

/// One call of a traced function: its arguments, its result or error, and the iii call it ran in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Span {
    pub id: String,
    pub name: String,
    pub worker: Option<String>,
    pub invocation_id: Option<String>,
    pub function_id: Option<String>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub started_at_ms: u64,
    pub duration_ms: f64,
    pub status: Status,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl Span {
    pub fn from_event(event: Event) -> Self {
        Span {
            id: event.invocation_id,
            name: event.function_id,
            worker: event.caller_worker,
            invocation_id: event.caller_invocation_id,
            function_id: event.caller_function_id,
            trace_id: event.trace_id,
            span_id: event.span_id,
            started_at_ms: event.started_at_ms,
            duration_ms: event.duration_ms,
            status: event.status,
            input: event.input.unwrap_or(Value::Null),
            output: event.output,
            error: event.error,
        }
    }
}

fn span_from_row(row: &Row) -> rusqlite::Result<Span> {
    Ok(Span {
        id: row.get(0)?,
        invocation_id: row.get(1)?,
        function_id: row.get(2)?,
        name: row.get(3)?,
        worker: row.get(4)?,
        trace_id: row.get(5)?,
        span_id: row.get(6)?,
        started_at_ms: row.get::<_, i64>(7)? as u64,
        duration_ms: row.get(8)?,
        status: Status::parse(&row.get::<_, String>(9)?),
        input: json_column(row, 10)?.unwrap_or(Value::Null),
        output: json_column(row, 11)?,
        error: json_column(row, 12)?,
    })
}

pub struct Spans {
    conn: Mutex<Connection>,
}

impl Spans {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|error| Error::SpansFile(format!("{}: {error}", dir.display())))?;
        }

        let conn = Connection::open(path).map_err(Error::Spans)?;
        store::tune(&conn).map_err(Error::Spans)?;
        conn.execute_batch(SCHEMA).map_err(Error::Spans)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Self { conn: Mutex::new(conn) }
    }

    fn with<T>(&self, work: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut conn).map_err(Error::Spans)
    }

    /// Stores every span from one read of the capture file in a single transaction.
    pub fn insert_all(&self, spans: &[Span]) -> Result<()> {
        if spans.is_empty() {
            return Ok(());
        }

        self.with(|conn| {
            let transaction = conn.transaction()?;
            {
                let mut statement = transaction.prepare_cached(&format!(
                    "insert or replace into spans ({COLUMNS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
                ))?;
                for span in spans {
                    statement.execute(params![
                        span.id,
                        span.invocation_id,
                        span.function_id,
                        span.name,
                        span.worker,
                        span.trace_id,
                        span.span_id,
                        span.started_at_ms as i64,
                        span.duration_ms,
                        span.status.as_str(),
                        span.input.to_string(),
                        span.output.as_ref().map(Value::to_string),
                        span.error.as_ref().map(Value::to_string),
                    ])?;
                }
            }
            transaction.commit()
        })
    }

    /// The spans made inside one iii call, in start order.
    pub fn of_invocation(&self, invocation_id: &str) -> Result<Vec<Span>> {
        self.with(|conn| {
            let mut statement = conn.prepare_cached(&format!(
                "select {COLUMNS} from spans where invocation_id = ?1 order by started_at_ms"
            ))?;
            let rows = statement.query_map(params![invocation_id], span_from_row)?;
            rows.collect()
        })
    }

    /// Drops spans that started before `cutoff_ms`. A replay never reads them, so nothing else changes.
    pub fn delete_before(&self, cutoff_ms: u64) -> Result<usize> {
        self.with(|conn| conn.execute("delete from spans where started_at_ms < ?1", params![cutoff_ms as i64]))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn span(id: &str, invocation_id: &str, started_at_ms: u64) -> Span {
        Span {
            id: id.into(),
            name: "function src/main.py:find_slot".into(),
            worker: Some("tools".into()),
            invocation_id: Some(invocation_id.into()),
            function_id: Some("calendar::find-slot".into()),
            trace_id: Some("0af7651916cd43dd8448eb211c80319c".into()),
            span_id: Some("b7ad6b7169203331".into()),
            started_at_ms,
            duration_ms: 1.5,
            status: "error".into(),
            input: json!({ "args": [{ "duration": "30" }] }),
            output: None,
            error: Some(json!({ "code": "TypeError", "message": "unsupported type" })),
        }
    }

    #[test]
    fn spans_come_back_for_their_invocation_in_start_order() {
        let spans = Spans::in_memory();
        spans.insert_all(&[span("b", "inv-1", 20), span("a", "inv-1", 10), span("c", "inv-2", 5)]).unwrap();
        let found = spans.of_invocation("inv-1").unwrap();
        assert_eq!(found.iter().map(|span| span.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(found[0], span("a", "inv-1", 10));
    }

    #[test]
    fn old_spans_are_dropped_and_newer_ones_kept() {
        let spans = Spans::in_memory();
        spans.insert_all(&[span("old", "inv-1", 10), span("new", "inv-1", 30)]).unwrap();
        assert_eq!(spans.delete_before(20).unwrap(), 1);
        assert_eq!(spans.of_invocation("inv-1").unwrap().len(), 1);
    }
}
