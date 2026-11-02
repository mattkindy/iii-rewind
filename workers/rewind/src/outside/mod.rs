//! Calls that go around iii, which a preload in the worker captures. Each is stored as an event
//! with a function id that starts with its kind, such as `fetch GET http://127.0.0.1:49335/holidays`.
//! `request` compares and normalizes requests, and `live` sends one from Rewind.

mod live;
mod request;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use live::{BODY_CUT_CODE, live_request};
pub use request::{body_was_cut, called_by, normalize_request, same_request, stub_request};

use crate::effects::Effect;

/// The function a copy's preload calls in its namespace to ask how a request should go.
pub const OUTSIDE_FUNCTION: &str = "rewind::outside";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    #[default]
    Iii,
    Fetch,
    HttpOut,
    Function,
    HttpIn,
}

const OUTSIDE_KINDS: [Kind; 4] = [Kind::Fetch, Kind::HttpOut, Kind::Function, Kind::HttpIn];

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Iii => "iii",
            Kind::Fetch => "fetch",
            Kind::HttpOut => "http_out",
            Kind::Function => "function",
            Kind::HttpIn => "http_in",
        }
    }

    pub fn parse(text: Option<&str>) -> Kind {
        OUTSIDE_KINDS
            .into_iter()
            .find(|kind| Some(kind.as_str()) == text)
            .unwrap_or(Kind::Iii)
    }

    /// The kind a function id starts with. iii function ids have no spaces.
    pub fn of_id(function_id: &str) -> Kind {
        let first_word = function_id.split_once(' ').map(|(word, _)| word);
        match first_word {
            Some(word) => Kind::parse(Some(word)),
            None => Kind::Iii,
        }
    }

    /// A request the code under test made takes a seq in its run, so a replay returns
    /// the recorded response there. Function spans and inbound requests never do.
    pub fn is_step(self) -> bool {
        matches!(self, Kind::Iii | Kind::Fetch | Kind::HttpOut)
    }

    pub fn is_request(self) -> bool {
        matches!(self, Kind::Fetch | Kind::HttpOut)
    }
}

/// What a call went through, flattened into each call so the page can mark calls around iii.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Origin {
    #[serde(default)]
    pub kind: Kind,
    #[serde(default)]
    pub outside_iii: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Origin {
    pub fn of(function_id: &str, input: &Value) -> Self {
        let kind = Kind::of_id(function_id);
        let text = |field: &str| kind.is_request().then(|| input[field].as_str().map(str::to_string)).flatten();
        Origin {
            kind,
            outside_iii: kind != Kind::Iii,
            method: text("method"),
            url: text("url"),
        }
    }
}

pub fn request_id(kind: Kind, method: &str, url: &str) -> String {
    format!("{} {} {url}", kind.as_str(), method.to_uppercase())
}

/// The effects of a call around iii, or none for an iii function, whose owner declares them.
pub fn effects(function_id: &str) -> Option<Vec<Effect>> {
    let kind = Kind::of_id(function_id);
    if kind == Kind::Iii {
        return None;
    }

    if !kind.is_request() {
        return Some(Vec::new());
    }

    let method = function_id.split(' ').nth(1).unwrap_or_default();
    Some(request_effects(method))
}

/// Nobody declares effects for a request, so GET and HEAD count as read-only, which lets
/// them run live, and anything else as external and irreversible, which never does.
pub fn request_effects(method: &str) -> Vec<Effect> {
    if ["GET", "HEAD"].contains(&method.to_uppercase().as_str()) {
        return vec![Effect::ReadOnly];
    }

    vec![Effect::External, Effect::Irreversible]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_function_id_says_its_kind() {
        assert_eq!(Kind::of_id("fetch GET http://x/holidays"), Kind::Fetch);
        assert_eq!(Kind::of_id("http_out POST http://x/send"), Kind::HttpOut);
        assert_eq!(Kind::of_id("function src/main.py:find_slot"), Kind::Function);
        assert_eq!(Kind::of_id("calendar::find-slot"), Kind::Iii);
        assert_eq!(Kind::of_id("odd name"), Kind::Iii);
        assert!(Kind::Fetch.is_step() && !Kind::Function.is_step() && !Kind::HttpIn.is_step());
    }

    #[test]
    fn an_undeclared_get_or_head_is_read_only_and_anything_else_irreversible() {
        assert_eq!(effects("fetch GET http://x/holidays"), Some(vec![Effect::ReadOnly]));
        assert_eq!(effects("http_out HEAD http://x/"), Some(vec![Effect::ReadOnly]));
        let irreversible = Some(vec![Effect::External, Effect::Irreversible]);
        assert_eq!(effects("fetch POST http://x/send"), irreversible);
        assert_eq!(effects("http_out DELETE http://x/1"), irreversible);
        assert_eq!(effects("calendar::find-slot"), None);
        assert_eq!(request_effects("get"), vec![Effect::ReadOnly]);
    }

    #[test]
    fn a_request_call_shows_its_method_and_url() {
        let holidays = json!({ "method": "GET", "url": "http://x/holidays", "headers": {}, "body": null });
        let origin = Origin::of("fetch GET http://x/holidays", &holidays);
        assert!(origin.outside_iii);
        assert_eq!(origin.method.as_deref(), Some("GET"));
        assert_eq!(Origin::of("clock::now", &json!({})), Origin::default());
    }
}
