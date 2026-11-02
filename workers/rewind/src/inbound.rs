//! Requests that arrived at a worker's own HTTP server, which the Node preload captures as
//! `http_in`. Each is the root of a run. A replay starts a copy of that worker, sends it the
//! recorded request, and ends with the response the copy gives back.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    app::App,
    catalog,
    code::CodeVersion,
    copies::ForkSpace,
    effects::Effect,
    error::{Error, Result},
    outside,
    replay::{Policy, Session, Unanswered},
    sources::WorkerSource,
    store::Event,
    forks::ForkRecord,
    namespaces,
    time::now_ms,
    types::{Answer, Mode, Outcome, Step},
};

// A cold Node start with tsx takes a few seconds, more on a busy machine.
const LISTEN_TIMEOUT: Duration = Duration::from_secs(90);

/// The copy's address in place of the host the request was sent to.
pub fn retarget(url: &str, address: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let path = rest.find('/').map(|at| &rest[at..]).unwrap_or("/");
    Some(format!("http://{address}{path}"))
}

/// The preload uses the worker's folder name as the worker, which is its container name in compose.
fn worker_source(app: &App, worker: &str) -> Result<WorkerSource> {
    if worker.is_empty() {
        return Err(Error::NotFound("the recorded request does not say which worker received it".into()));
    }

    app.worker_source(worker)
}

/// A request whose method could change something would run its handler's effects again.
fn replayable(request: &Value) -> Result<()> {
    let method = request["method"].as_str().unwrap_or_default();
    if outside::request_effects(method).contains(&Effect::Irreversible) {
        return Err(Error::NotReplayable(format!(
            "a {method} request is not replayed, because its handler may change something again"
        )));
    }

    if outside::body_was_cut(request) {
        return Err(Error::BodyTruncated(
            "the request's body was cut at REWIND_MAX_BODY_BYTES when it was captured, so it is not replayed".into(),
        ));
    }

    Ok(())
}

async fn send_recorded(address: &str, request: &Value) -> Result<Outcome> {
    let url = request["url"].as_str().and_then(|url| retarget(url, address));
    let Some(url) = url else {
        return Err(Error::BadRecording("the recorded request has no url".into()));
    };

    let mut sent = request.clone();
    sent["url"] = json!(url);
    Ok(match outside::live_request(&sent).await {
        Answer::Value { value } => Outcome::Done { output: value },
        Answer::Error { error } => Outcome::Crashed { error },
    })
}

struct Replayed {
    outcome: Outcome,
    steps: Vec<Step>,
    code: CodeVersion,
}

/// Sends the recorded request to the copy in `space`. The handler's iii calls reach stubs and its
/// requests around iii reach `rewind::outside`, which answer from the recording and never run live.
async fn replay_in(app: &Arc<App>, space: &ForkSpace, run: &Event, request: &Value) -> Result<Replayed> {
    let rows = catalog::list(&app.iii).await?;
    app.catalog.replace(&rows);
    space.ensure_stubs(app).await?;
    let (address, code) = space.serving(app, LISTEN_TIMEOUT).await?;
    let policy = Policy::new(Mode::Debug, false, Unanswered::Pause);
    space.install(Session::new(policy, app.steps_of(run)?, BTreeMap::new()).of_run(run, HashMap::new()));
    let outcome = send_recorded(&address, request).await;
    let session = space.take().ok_or_else(|| Error::Internal("the replay's session went missing".into()))?;
    Ok(Replayed {
        outcome: outcome?,
        steps: session.into_steps(),
        code,
    })
}

pub async fn replay(app: &Arc<App>, run: &Event) -> Result<ForkRecord> {
    let request = run.input.clone().unwrap_or(Value::Null);
    replayable(&request)?;
    let worker = run.caller_worker.clone().unwrap_or_default();
    worker_source(app, &worker)?;
    let number = app.store.next_fork_number()?;
    let namespace = namespaces::inbound(number);
    let space = app.spaces.open(app, &namespace, std::slice::from_ref(&worker)).await?;
    let replayed = replay_in(app, &space, run, &request).await;
    app.spaces.close(&namespace).await;
    let Replayed { outcome, steps, code } = replayed?;

    let record = ForkRecord {
        fork_id: format!("f{number}"),
        number,
        run_id: run.invocation_id.clone(),
        parent: None,
        edit_at: None,
        namespace,
        mode: Mode::Debug,
        auto_read: false,
        auto: false,
        stops: Vec::new(),
        copy: vec![worker],
        answers: BTreeMap::new(),
        steps,
        outcome,
        created_at_ms: now_ms(),
        code: Some(code),
        trace_id: None,
        span_id: None,
        rerun: None,
    };
    app.store.put_fork(&record)?;
    app.changes.emit("fork", &record.fork_id);
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_request_goes_to_the_copys_address_with_its_path_and_query() {
        assert_eq!(
            retarget("http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2", "127.0.0.1:61234").as_deref(),
            Some("http://127.0.0.1:61234/holidays?from=2026-11-03&weeks=2")
        );
        assert_eq!(retarget("http://localhost", "127.0.0.1:1").as_deref(), Some("http://127.0.0.1:1/"));
        assert_eq!(retarget("no scheme", "127.0.0.1:1"), None);
    }

    #[test]
    fn only_requests_that_change_nothing_are_replayed() {
        assert!(replayable(&json!({ "method": "GET" })).is_ok());
        assert!(replayable(&json!({ "method": "HEAD" })).is_ok());
        assert!(replayable(&json!({ "method": "POST" })).is_err());
    }

    #[test]
    fn a_request_whose_body_was_cut_is_not_replayed() {
        let cut = json!({ "method": "GET", "body": "{", "body_truncated": { "bytes": 70_000, "sha256": "aaaa" } });
        let refused = replayable(&cut).unwrap_err();
        assert_eq!(refused.code(), outside::BODY_CUT_CODE, "{refused}");
    }
}
