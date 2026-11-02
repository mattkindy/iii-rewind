//! Sending a request around iii from Rewind, for a call that runs live. Headers the preload hid go
//! out only with a value from Rewind's own environment, and a request whose body the preload cut
//! is never sent.

use std::{sync::OnceLock, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value, json};

use super::body_was_cut;
use crate::types::Answer;

// The HTTP client sets these itself, and the live response comes back uncompressed.
const HEADERS_NOT_SENT_LIVE: [&str; 5] = ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"];

const LIVE_TIMEOUT: Duration = Duration::from_secs(30);

/// What the stored value of a header the preload hid is.
const REDACTED: &str = "[redacted]";

pub const BODY_CUT_CODE: &str = "REWIND_BODY_TRUNCATED";

/// Where Rewind looks for a value of a hidden header for a live send, such as
/// `REWIND_LIVE_HEADER_X_API_KEY` for `x-api-key`.
fn live_header_variable(name: &str) -> String {
    let upper: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect();
    format!("REWIND_LIVE_HEADER_{upper}")
}

/// The headers the preload hid, by name: the ones a copy's question lists in `redacted_headers`,
/// and the ones a capture stored as `[redacted]`.
fn hidden_headers(request: &Value) -> Vec<String> {
    let listed = request["redacted_headers"].as_array().into_iter().flatten().filter_map(Value::as_str);
    let stored = request["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, value)| value.as_str() == Some(REDACTED))
        .map(|(name, _)| name.as_str());
    let mut names: Vec<String> = listed.chain(stored).map(str::to_lowercase).collect();
    names.sort();
    names.dedup();
    names
}

/// The headers a live send goes out with: the request's own, without the hidden ones, and each
/// hidden one that `lookup` has a value for under its `REWIND_LIVE_HEADER_` name.
fn live_headers(request: &Value, lookup: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let hidden = hidden_headers(request);
    let own = request["headers"].as_object().into_iter().flatten().filter_map(|(name, value)| {
        let lower = name.to_lowercase();
        let skipped = HEADERS_NOT_SENT_LIVE.contains(&lower.as_str()) || hidden.contains(&lower);
        let value = value.as_str().filter(|_| !skipped)?;
        Some((name.clone(), value.to_string()))
    });
    let filled = hidden
        .iter()
        .filter_map(|name| lookup(&live_header_variable(name)).map(|value| (name.clone(), value)));
    own.chain(filled).collect()
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(LIVE_TIMEOUT).build().unwrap_or_default())
}

fn body_of(request: &Value) -> Result<Vec<u8>, String> {
    let Some(body) = request["body"].as_str() else {
        return Ok(Vec::new());
    };
    if request["body_encoding"] == "base64" {
        return BASE64.decode(body).map_err(|error| format!("the body is not valid base64: {error}"));
    }

    Ok(body.as_bytes().to_vec())
}

fn body_fields(bytes: &[u8], response: &mut Map<String, Value>) {
    if bytes.is_empty() {
        response.insert("body".into(), Value::Null);
        return;
    }

    match std::str::from_utf8(bytes) {
        Ok(text) => {
            response.insert("body".into(), json!(text));
        }
        Err(_) => {
            response.insert("body".into(), json!(BASE64.encode(bytes)));
            response.insert("body_encoding".into(), json!("base64"));
        }
    }
}

fn header_object(headers: &reqwest::header::HeaderMap) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, value) in headers {
        let text = String::from_utf8_lossy(value.as_bytes()).to_string();
        let joined = match out.get(name.as_str()).and_then(Value::as_str) {
            Some(earlier) => format!("{earlier}, {text}"),
            None => text,
        };
        out.insert(name.as_str().to_string(), json!(joined));
    }

    out
}

/// The response as a value, or the text of the `FETCH_FAILED` error the caller gets instead.
async fn send(request: &Value) -> Result<Value, String> {
    let method = request["method"].as_str().unwrap_or("GET");
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let url = request["url"].as_str().ok_or("the request has no url")?;
    let mut outgoing = client().request(method, url);
    for (name, value) in live_headers(request, |variable| std::env::var(variable).ok()) {
        outgoing = outgoing.header(name, value);
    }

    let body = body_of(request)?;
    if !body.is_empty() {
        outgoing = outgoing.body(body);
    }

    let response = outgoing.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let headers = header_object(response.headers());
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let mut answer = Map::new();
    answer.insert("status".into(), json!(status.as_u16()));
    answer.insert("status_text".into(), json!(status.canonical_reason().unwrap_or_default()));
    answer.insert("headers".into(), Value::Object(headers));
    body_fields(&bytes, &mut answer);
    Ok(Value::Object(answer))
}

/// What a request whose body the preload cut gets instead of being sent.
fn cut_body_error() -> Answer {
    Answer::error(
        Some(BODY_CUT_CODE),
        "the preload cut this request's body at REWIND_MAX_BODY_BYTES, so Rewind won't send it live",
    )
}

/// Makes the request from Rewind. A response with any status is a value, the way fetch
/// treats it, and only a request that never got a response is an error.
pub async fn live_request(request: &Value) -> Answer {
    if body_was_cut(request) {
        return cut_body_error();
    }

    match send(request).await {
        Ok(response) => Answer::value(response),
        Err(message) => Answer::error(Some("FETCH_FAILED"), message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_request_with_a_cut_body_is_never_sent_live() {
        let unreachable = json!({ "method": "POST", "url": "http://127.0.0.1:9/never", "body": "{", "body_truncated": { "bytes": 70_000, "sha256": "aaaa" } });
        assert_eq!(live_request(&unreachable).await, cut_body_error());
    }

    #[test]
    fn a_hidden_header_goes_out_only_when_rewinds_environment_has_a_value_for_it() {
        let question = json!({
            "method": "GET",
            "url": "http://x/",
            "headers": { "accept": "*/*", "Host": "x", "Cookie": "[redacted]" },
            "redacted_headers": ["Authorization", "x-api-key"],
        });
        let environment = |variable: &str| match variable {
            "REWIND_LIVE_HEADER_AUTHORIZATION" => Some("Bearer test-token".to_string()),
            "REWIND_LIVE_HEADER_COOKIE" => Some("session=test".to_string()),
            _ => None,
        };
        let mut sent = live_headers(&question, environment);
        sent.sort();
        let expected = [("accept", "*/*"), ("authorization", "Bearer test-token"), ("cookie", "session=test")]
            .map(|(name, value)| (name.to_string(), value.to_string()));
        assert_eq!(sent, expected);

        let mut without = live_headers(&question, |_| None);
        without.sort();
        assert_eq!(without, [("accept".to_string(), "*/*".to_string())]);
        assert_eq!(live_header_variable("x-api-key"), "REWIND_LIVE_HEADER_X_API_KEY");
    }
}
