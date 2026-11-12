//! The engine's function list, and waiting for functions to show up in it.
//! `register_function` returns before the engine has the function, so Rewind
//! polls the list before it relies on a stub or a copy.

use std::{
    collections::HashMap,
    sync::RwLock,
    time::{Duration, Instant},
};

use iii_sdk::{CallRequest, IIIClient, engine::EngineFunctions};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    effects::{self, Effect},
    error::{Error, Result},
    outside,
};

pub const DEFAULT_NAMESPACE: &str = "default";

#[derive(Debug, Clone, PartialEq)]
pub struct FunctionRow {
    pub function_id: String,
    pub namespace: String,
    pub worker: String,
    pub effects: Vec<Effect>,
    /// Whether the function's metadata says `effects` at all, which is what puts it on the record list.
    pub declares_effects: bool,
    /// `metadata.internal`, which keeps a function off the record list and out of the runs.
    pub internal: bool,
    /// `metadata.idempotency_key`: the function drops a call whose key it has seen before.
    pub takes_key: bool,
}

impl FunctionRow {
    pub fn from_listing(row: &Value) -> Option<Self> {
        let effects = row["metadata"]["effects"].as_array();
        Some(Self {
            internal: row["metadata"]["internal"] == Value::Bool(true),
            takes_key: row["metadata"]["idempotency_key"] == Value::Bool(true),
            function_id: row["function_id"].as_str()?.to_string(),
            namespace: row["namespace"]
                .as_str()
                .unwrap_or(DEFAULT_NAMESPACE)
                .to_string(),
            worker: row["worker_name"].as_str().unwrap_or_default().to_string(),
            effects: effects.map(|list| effects::from_metadata(list)).unwrap_or_default(),
            declares_effects: effects.is_some(),
        })
    }
}

/// A function's request and response formats, as `engine::functions::info` reports them under
/// `request_schema` and `response_schema`. `engine::functions::list` leaves them out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Formats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_format: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
}

impl Formats {
    fn from_info(row: &Value) -> Self {
        let schema = |key: &str| row.get(key).filter(|schema| !schema.is_null()).cloned();
        Self {
            request_format: schema("request_schema"),
            response_format: schema("response_schema"),
        }
    }
}

// The most ids engine::functions::info takes in one call.
const INFO_BATCH: usize = 32;

/// The formats of each function in `default`, keyed by function id. A function that is gone,
/// or declares no formats, gets none.
pub async fn formats(iii: &IIIClient, function_ids: &[String]) -> Result<HashMap<String, Formats>> {
    let mut found = HashMap::new();
    for batch in function_ids.chunks(INFO_BATCH) {
        let input = json!({ "function_ids": batch, "namespace": DEFAULT_NAMESPACE });
        let mut request = CallRequest::new(EngineFunctions::INFO_FUNCTIONS, input);
        request.timeout_ms = Some(10_000);
        let info = iii.call(request).await?;
        for row in info["functions"].as_array().into_iter().flatten() {
            if let Some(function_id) = row["function_id"].as_str() {
                found.insert(function_id.to_string(), Formats::from_info(row));
            }
        }
    }

    Ok(found)
}

/// The response format of the function a fork paused at, so a page can build the answer from it.
/// A call around iii has none, and a lookup that fails leaves it out.
pub async fn response_format(iii: &IIIClient, function_id: &str) -> Option<Value> {
    if outside::Kind::of_id(function_id) != outside::Kind::Iii {
        return None;
    }

    match formats(iii, &[function_id.to_string()]).await {
        Ok(mut found) => found.remove(function_id).and_then(|formats| formats.response_format),
        Err(error) => {
            eprintln!("rewind: could not look up the formats of {function_id}: {error}");
            None
        }
    }
}

pub async fn list(iii: &IIIClient) -> Result<Vec<FunctionRow>> {
    let mut request = CallRequest::new(EngineFunctions::LIST_FUNCTIONS, json!({}));
    request.timeout_ms = Some(10_000);
    let listed = iii.call(request).await?;
    Ok(listed["functions"]
        .as_array()
        .map(|rows| rows.iter().filter_map(FunctionRow::from_listing).collect())
        .unwrap_or_default())
}

/// Polls the list until every one of `function_ids` is in `namespace` when `present`,
/// or none of them is when not.
async fn wait_until(
    iii: &IIIClient,
    namespace: &str,
    function_ids: &[String],
    present: bool,
    timeout: Duration,
    mut still_worth_waiting: impl FnMut() -> Result<()>,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let listed = list(iii).await?;
        let waiting_on: Vec<&String> = function_ids
            .iter()
            .filter(|id| {
                let listed_here = listed
                    .iter()
                    .any(|row| row.namespace == namespace && &row.function_id == *id);
                listed_here != present
            })
            .collect();
        if waiting_on.is_empty() {
            return Ok(());
        }

        still_worth_waiting()?;
        if Instant::now() > deadline {
            return Err(gave_up_waiting(present, format!("in namespace {namespace} after {timeout:?}: {waiting_on:?}")));
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The error for a wait that ran out, saying what was still wrong.
fn gave_up_waiting(present: bool, detail: String) -> Error {
    if present {
        return Error::NotRegistered(format!("still missing {detail}"));
    }

    Error::StillRegistered(format!("still registered {detail}"))
}

pub async fn wait_for(
    iii: &IIIClient,
    namespace: &str,
    function_ids: &[String],
    timeout: Duration,
    still_worth_waiting: impl FnMut() -> Result<()>,
) -> Result<()> {
    wait_until(iii, namespace, function_ids, true, timeout, still_worth_waiting).await
}

/// The engine drops a stopped worker's functions a moment after its connection
/// closes, and until then a call can still be routed to the stopped worker.
pub async fn wait_until_gone(iii: &IIIClient, namespace: &str, function_ids: &[String], timeout: Duration) -> Result<()> {
    wait_until(iii, namespace, function_ids, false, timeout, || Ok(())).await
}

/// Calls are shown with their function's worker and effects, which the
/// recording does not have, so Rewind keeps the last listing of `default`.
#[derive(Default)]
pub struct Catalog {
    rows: RwLock<HashMap<String, FunctionRow>>,
}

impl Catalog {
    pub fn replace(&self, rows: &[FunctionRow]) {
        let by_id = rows
            .iter()
            .filter(|row| row.namespace == DEFAULT_NAMESPACE)
            .map(|row| (row.function_id.clone(), row.clone()))
            .collect();
        *self.rows.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = by_id;
    }

    pub fn get(&self, function_id: &str) -> Option<FunctionRow> {
        self.rows
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(function_id)
            .cloned()
    }

    pub fn all(&self) -> Vec<FunctionRow> {
        let mut rows: Vec<FunctionRow> = self
            .rows
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.function_id.cmp(&b.function_id));
        rows
    }

    /// The owner and declared effects of an iii function. A call around iii has no owner
    /// here and gets the effects Rewind gives it by default.
    pub fn describe(&self, function_id: &str) -> (String, Vec<Effect>) {
        if let Some(effects) = outside::effects(function_id) {
            return (String::new(), effects);
        }

        self.get(function_id)
            .map(|row| (row.worker, row.effects))
            .unwrap_or_default()
    }

    /// Whether the function's metadata says it takes an idempotency key. A function missing from
    /// the listing, such as one whose worker is restarting, gets none.
    pub fn takes_key(&self, function_id: &str) -> bool {
        self.get(function_id).is_some_and(|row| row.takes_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_come_from_the_info_schemas_as_they_are() {
        let request = json!({ "type": "object", "properties": { "duration": { "type": "integer" } } });
        let response = json!({ "oneOf": [{ "type": "object" }, { "type": "string" }] });
        let info = json!({ "function_id": "calendar::find-slot", "request_schema": request, "response_schema": response });
        let formats = Formats::from_info(&info);
        assert_eq!(formats.request_format, Some(request));
        assert_eq!(formats.response_format, Some(response));
    }

    #[test]
    fn a_function_takes_a_key_only_when_its_metadata_says_true() {
        let listed = |metadata: Value| json!({ "function_id": "email::send", "worker_name": "tools", "metadata": metadata });
        let send = FunctionRow::from_listing(&listed(json!({ "effects": ["irreversible"], "idempotency_key": true }))).unwrap();
        assert!(send.takes_key);
        for other in [json!({ "effects": ["irreversible"] }), json!({ "idempotency_key": "yes" }), Value::Null] {
            assert!(!FunctionRow::from_listing(&listed(other.clone())).unwrap().takes_key, "{other}");
        }

        let catalog = Catalog::default();
        catalog.replace(&[send]);
        assert!(catalog.takes_key("email::send"));
        assert!(!catalog.takes_key("billing::charge"));
    }

    #[test]
    fn a_function_without_formats_shows_none() {
        let gone = Formats::from_info(&json!({ "function_id": "billing::charge", "error": "not_found" }));
        assert_eq!(gone, Formats::default());
        assert_eq!(serde_json::to_value(&gone).unwrap(), json!({}));
    }
}
