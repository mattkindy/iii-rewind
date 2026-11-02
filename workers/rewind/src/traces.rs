//! Tying calls to the spans the ADE's Traces view shows. A handler's traceparent gives the
//! trace, and a call's own span is found in the engine's trace store the first time someone
//! asks, by its `execute <function_id>` name and a start within a couple of milliseconds.

use iii_sdk::{current_invocation, protocol::TriggerRequest};
use serde_json::{Value, json};

use crate::{app::App, error::Result, store::Event, types::Call};

const SPANS_FUNCTION: &str = "engine::traces::spans";
// Start times are recorded in whole milliseconds, and the span's clock can be a little off.
const START_TOLERANCE_MS: f64 = 2.5;
const PAGE: u64 = 500;
const MAX_PAGES: u64 = 20;

/// The trace and span ids in a W3C traceparent.
pub fn ids_of(traceparent: &str) -> Option<(String, String)> {
    let mut parts = traceparent.split('-');
    let (_, trace_id, span_id) = (parts.next()?, parts.next()?, parts.next()?);
    let valid = trace_id.len() == 32 && span_id.len() == 16 && trace_id.chars().chain(span_id.chars()).all(|c| c.is_ascii_hexdigit());
    valid.then(|| (trace_id.to_string(), span_id.to_string()))
}

/// The trace and span of the handler running now, which for a stub is the stub's own span.
pub fn current() -> (Option<String>, Option<String>) {
    let ids = current_invocation().and_then(|invocation| invocation.traceparent).and_then(|traceparent| ids_of(&traceparent));
    match ids {
        Some((trace_id, span_id)) => (Some(trace_id), Some(span_id)),
        None => (None, None),
    }
}

// A run that a caller started inside its own trace shares that trace, so a trace can have
// thousands of spans.
async fn spans_of(app: &App, trace_id: &str) -> Result<Vec<Value>> {
    let mut spans = Vec::new();
    for page_number in 0..MAX_PAGES {
        let mut request = TriggerRequest::new(
            SPANS_FUNCTION,
            json!({ "trace_id": trace_id, "search_all_spans": true, "offset": page_number * PAGE, "limit": PAGE }),
        );
        request.timeout_ms = Some(10_000);
        let page = app.iii.trigger(request).await?;
        let found = page["spans"].as_array().cloned().unwrap_or_default();
        let last_page = (found.len() as u64) < PAGE;
        spans.extend(found);
        if last_page {
            break;
        }
    }

    Ok(spans)
}

fn start_ms(span: &Value) -> f64 {
    span["start_time_unix_nano"].as_f64().unwrap_or(0.0) / 1e6
}

/// The `execute <function_id>` span nearest `started_at_ms`, if one is close enough.
pub fn nearest_execute<'a>(spans: &'a [Value], function_id: &str, started_at_ms: u64, taken: &[String]) -> Option<&'a Value> {
    let name = format!("execute {function_id}");
    spans
        .iter()
        .filter(|span| span["name"] == name.as_str())
        .filter(|span| !taken.iter().any(|id| span["span_id"] == id.as_str()))
        .map(|span| (span, (start_ms(span) - started_at_ms as f64).abs()))
        .filter(|(_, apart)| *apart <= START_TOLERANCE_MS)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(span, _)| span)
}

/// Fills in the span of each recorded call that has a trace but no span yet, and stores what it finds.
pub async fn resolve_calls(app: &App, calls: &mut [Call]) -> Result<()> {
    let Some(trace_id) = calls.iter().find(|call| call.span_id.is_none()).and_then(|call| call.trace_id.clone()) else {
        return Ok(());
    };
    let spans = spans_of(app, &trace_id).await?;
    let mut taken: Vec<String> = calls.iter().filter_map(|call| call.span_id.clone()).collect();
    for call in calls.iter_mut().filter(|call| call.span_id.is_none() && call.trace_id.as_deref() == Some(&trace_id)) {
        let Some(started_at_ms) = call.started_at_ms else {
            continue;
        };
        let Some(span_id) = nearest_execute(&spans, &call.function_id, started_at_ms, &taken).and_then(|span| span["span_id"].as_str()) else {
            continue;
        };

        taken.push(span_id.to_string());
        call.span_id = Some(span_id.to_string());
        if let Some(invocation_id) = &call.invocation_id {
            app.store.set_span_id(invocation_id, span_id)?;
        }
    }

    Ok(())
}

/// The run's own `execute <entry>` span in the run's trace, stored once found.
pub async fn resolve_run(app: &App, run: &Event, trace_id: &str) -> Result<Option<String>> {
    let spans = spans_of(app, trace_id).await?;
    let found = nearest_execute(&spans, &run.function_id, run.started_at_ms, &[]).and_then(|span| span["span_id"].as_str());
    if let Some(span_id) = found {
        app.store.set_span_id(&run.invocation_id, span_id)?;
    }

    Ok(found.map(str::to_string))
}

/// The root of a rerun's trace: the copy's `execute <entry>` span.
pub async fn root_span(app: &App, trace_id: &str, entry: &str) -> Result<Option<String>> {
    let name = format!("execute {entry}");
    Ok(spans_of(app, trace_id)
        .await?
        .iter()
        .find(|span| span["name"] == name.as_str())
        .and_then(|span| span["span_id"].as_str().map(str::to_string)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_traceparent_gives_its_trace_and_span() {
        assert_eq!(
            ids_of("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"),
            Some(("0af7651916cd43dd8448eb211c80319c".into(), "b7ad6b7169203331".into()))
        );
        assert_eq!(ids_of("00-short-b7ad6b7169203331-01"), None);
    }

    #[test]
    fn a_call_gets_the_nearest_execute_span_with_its_name_not_yet_taken() {
        let span = |id: &str, name: &str, start_ms: f64| json!({ "span_id": id, "name": name, "start_time_unix_nano": start_ms * 1e6 });
        let spans = vec![
            span("a", "execute model::complete", 1000.4),
            span("b", "execute model::complete", 1001.9),
            span("c", "execute clock::now", 1000.0),
            span("d", "execute model::complete", 1900.0),
        ];
        assert_eq!(nearest_execute(&spans, "model::complete", 1000, &[]).unwrap()["span_id"], "a");
        assert_eq!(nearest_execute(&spans, "model::complete", 1000, &["a".into()]).unwrap()["span_id"], "b");
        assert!(nearest_execute(&spans, "email::send", 1000, &[]).is_none());
        assert!(nearest_execute(&spans, "model::complete", 1500, &[]).is_none());
    }
}
