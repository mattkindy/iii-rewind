//! A request around iii as Rewind keeps and compares it. The trace headers the SDK adds change on
//! every run, so they are dropped, and two requests match on method, URL and body.

use serde_json::{Value, json};

use super::{Kind, request_id};
use crate::{
    error::{Error, Result},
    json::canonical,
    replay::CalledBy,
};

/// Headers the iii SDK adds to every fetch, which differ on every run.
const TRACE_HEADERS: [&str; 2] = ["traceparent", "baggage"];

/// What a copy's preload adds to a request it asks about: `{ invocation_id, caller_invocation_id }`
/// of the handler the request ran in.
const INVOCATION_FIELD: &str = "invocation";

/// A request as Rewind keeps it: the method, the URL, the headers without the trace
/// headers, and the body, which is text or base64 with `body_encoding`.
pub fn normalize_request(input: &Value) -> Value {
    let mut request = input.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(headers)) = request.get_mut("headers") {
        headers.retain(|name, _| !TRACE_HEADERS.contains(&name.to_lowercase().as_str()));
    }

    if let Some(method) = input["method"].as_str() {
        request.insert("method".into(), json!(method.to_uppercase()));
    }

    request.remove("kind");
    request.remove("worker");
    request.remove(INVOCATION_FIELD);
    Value::Object(request)
}

/// Which invocation made a request a copy's preload asks about, when the preload says.
pub fn called_by(payload: &Value) -> Option<CalledBy> {
    let invocation = payload.get(INVOCATION_FIELD)?;
    let text = |field: &str| invocation[field].as_str().map(str::to_string);
    let invocation_id = text("invocation_id")?;
    Some(CalledBy {
        invocation_id: Some(invocation_id),
        parent_invocation_id: text("caller_invocation_id"),
    })
}

/// Two requests match when the method, the URL and the body are the same, and so does the hash
/// of the whole body when the preload cut it. Headers are left out, so the trace headers and
/// anything else that changes per run never matter.
pub fn same_request(a: &Value, b: &Value) -> bool {
    let key = |request: &Value| {
        let encoding = request["body_encoding"].as_str().unwrap_or("utf8");
        let whole = &request["body_truncated"]["sha256"];
        canonical(&json!([request["method"].as_str().map(str::to_uppercase), request["url"], request["body"], encoding, whole]))
    };
    key(a) == key(b)
}

/// Whether the preload cut the request's body at `REWIND_MAX_BODY_BYTES`, so sending it would
/// send only the start of what the worker meant to.
pub fn body_was_cut(request: &Value) -> bool {
    !request["body_truncated"].is_null()
}

/// The function id, input and worker for a request a copy's preload asks about.
pub fn stub_request(payload: &Value) -> Result<(String, Value, String)> {
    let kind = Kind::parse(payload["kind"].as_str());
    let (Some(method), Some(url)) = (payload["method"].as_str(), payload["url"].as_str()) else {
        return Err(Error::BadInput("a request needs a method and a url".into()));
    };
    if !kind.is_request() {
        return Err(Error::BadInput("kind must be fetch or http_out".into()));
    }

    let worker = payload["worker"].as_str().unwrap_or_default().to_string();
    Ok((request_id(kind, method, url), normalize_request(payload), worker))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holidays(day: &str) -> Value {
        json!({
            "method": "GET",
            "url": format!("http://127.0.0.1:49335/holidays?from={day}&weeks=2"),
            "headers": { "accept": "*/*" },
            "body": null,
        })
    }

    #[test]
    fn requests_match_on_method_url_and_body() {
        assert!(same_request(&holidays("2026-11-03"), &holidays("2026-11-03")));
        assert!(!same_request(&holidays("2026-11-03"), &holidays("2026-11-11")));

        let mut posted = holidays("2026-11-03");
        posted["method"] = json!("post");
        posted["body"] = json!("{\"a\":1}");
        let mut upper = posted.clone();
        upper["method"] = json!("POST");
        assert!(same_request(&posted, &upper));
        assert!(!same_request(&posted, &holidays("2026-11-03")));

        let mut other_body = posted.clone();
        other_body["body"] = json!("{\"a\":2}");
        assert!(!same_request(&posted, &other_body));
    }

    fn cut_post(start: &str, sha256: &str) -> Value {
        let mut posted = holidays("2026-11-03");
        posted["method"] = json!("POST");
        posted["body"] = json!(start);
        posted["body_truncated"] = json!({ "bytes": 100_000, "sha256": sha256 });
        posted
    }

    #[test]
    fn cut_bodies_match_only_when_the_whole_bodies_hash_the_same() {
        assert!(same_request(&cut_post("{\"a\":", "aaaa"), &cut_post("{\"a\":", "aaaa")));
        assert!(!same_request(&cut_post("{\"a\":", "aaaa"), &cut_post("{\"a\":", "bbbb")));

        let mut whole = cut_post("{\"a\":", "aaaa");
        whole.as_object_mut().unwrap().remove("body_truncated");
        assert!(!same_request(&whole, &cut_post("{\"a\":", "aaaa")));
        assert!(body_was_cut(&cut_post("x", "aaaa")));
        assert!(!body_was_cut(&whole));
    }

    #[test]
    fn the_trace_headers_are_dropped_and_never_matched() {
        let mut traced = holidays("2026-11-03");
        traced["headers"]["traceparent"] = json!("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
        traced["headers"]["Baggage"] = json!("user=matt");
        assert_eq!(normalize_request(&traced)["headers"], json!({ "accept": "*/*" }));
        assert!(same_request(&traced, &holidays("2026-11-03")));

        let mut other_trace = traced.clone();
        other_trace["headers"]["traceparent"] = json!("00-11111111111111111111111111111111-2222222222222222-01");
        assert!(same_request(&traced, &other_trace));
    }

    #[test]
    fn a_preloads_question_becomes_a_call() {
        let mut payload = holidays("2026-11-03");
        payload["kind"] = json!("fetch");
        payload["worker"] = json!("agent");
        payload["headers"]["traceparent"] = json!("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
        let (function_id, input, worker) = stub_request(&payload).unwrap();
        assert_eq!(function_id, "fetch GET http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2");
        assert_eq!(input, holidays("2026-11-03"));
        assert_eq!(worker, "agent");
        assert!(stub_request(&json!({ "kind": "function", "method": "GET", "url": "x" })).is_err());
        assert_eq!(called_by(&payload), None);

        payload["invocation"] = json!({ "invocation_id": "send-in-copy", "caller_invocation_id": "handler-1" });
        let (_, input, _) = stub_request(&payload).unwrap();
        assert_eq!(input, holidays("2026-11-03"));
        assert_eq!(
            called_by(&payload),
            Some(CalledBy {
                invocation_id: Some("send-in-copy".into()),
                parent_invocation_id: Some("handler-1".into()),
            })
        );
    }
}
