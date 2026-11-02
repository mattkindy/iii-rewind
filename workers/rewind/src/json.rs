//! Comparing a call's input with the recording, and a replay's outcome with the
//! recorded one. Two inputs match when they are the same canonical JSON once the
//! engine's `_caller_worker_id` is dropped.

use std::collections::BTreeSet;

use serde_json::{Number, Value};

/// The engine adds this to a routed call's input. The observer's copy of the input does not have it.
pub const CALLER_FIELD: &str = "_caller_worker_id";

pub fn normalize_input(input: &Value) -> Value {
    match input {
        Value::Object(map) if map.contains_key(CALLER_FIELD) => {
            let mut map = map.clone();
            map.remove(CALLER_FIELD);
            Value::Object(map)
        }
        other => other.clone(),
    }
}

pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

pub fn same_input(a: &Value, b: &Value) -> bool {
    canonical(&normalize_input(a)) == canonical(&normalize_input(b))
}

/// `value` with every text in it, keys left alone, rewritten so each `from` becomes its `to`.
/// A request body is text, so an id inside its JSON is replaced too.
pub fn replace_text(value: &Value, pairs: &[(String, String)]) -> Value {
    if pairs.is_empty() {
        return value.clone();
    }

    match value {
        Value::String(text) => Value::String(
            pairs
                .iter()
                .fold(text.clone(), |text, (from, to)| text.replace(from.as_str(), to)),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|item| replace_text(item, pairs)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), replace_text(item, pairs)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The paths where two values differ, such as `/output/reply`. An array of a
/// different length differs as a whole. Numbers compare the way input matching does.
pub fn differences(a: &Value, b: &Value) -> Vec<String> {
    let mut found = Vec::new();
    collect_differences(a, b, "", &mut found);
    found
}

fn collect_differences(a: &Value, b: &Value, path: &str, found: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(left), Value::Object(right)) => {
            let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
            for key in keys {
                let child = format!("{path}/{key}");
                match (left.get(key), right.get(key)) {
                    (Some(l), Some(r)) => collect_differences(l, r, &child, found),
                    _ => found.push(child),
                }
            }
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (l, r)) in left.iter().zip(right).enumerate() {
                collect_differences(l, r, &format!("{path}/{index}"), found);
            }
        }
        _ if canonical(a) == canonical(b) => {}
        _ => found.push(path.to_string()),
    }
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                write_canonical(&map[key.as_str()], out);
            }

            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                write_canonical(item, out);
            }

            out.push(']');
        }
        Value::Number(number) => out.push_str(&canonical_number(number)),
        other => out.push_str(&other.to_string()),
    }
}

// Python and JavaScript both send 30 for thirty, but a round trip through a
// float can turn it into 30.0, which should still match.
fn canonical_number(number: &Number) -> String {
    if let Some(float) = number.as_f64()
        && number.is_f64()
        && float.fract() == 0.0
        && float.abs() < 9.0e15
    {
        return format!("{}", float as i64);
    }

    number.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn drops_the_engines_caller_field_at_the_top_level_only() {
        let routed = json!({ "_caller_worker_id": "w1", "day": "2026-11-03", "meta": { "_caller_worker_id": "keep" } });
        assert_eq!(
            normalize_input(&routed),
            json!({ "day": "2026-11-03", "meta": { "_caller_worker_id": "keep" } })
        );
    }

    #[test]
    fn leaves_inputs_that_are_not_objects_alone() {
        assert_eq!(normalize_input(&json!([1, 2])), json!([1, 2]));
        assert_eq!(normalize_input(&Value::Null), Value::Null);
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_level() {
        let a = json!({ "b": 1, "a": { "y": [1, { "q": 1, "p": 2 }], "x": null } });
        assert_eq!(canonical(&a), r#"{"a":{"x":null,"y":[1,{"p":2,"q":1}]},"b":1}"#);
    }

    #[test]
    fn a_routed_input_matches_its_recorded_copy() {
        let recorded = json!({ "attendee": "dana@example.com", "day": "2026-11-03", "duration": 30 });
        let routed = json!({ "duration": 30, "_caller_worker_id": "abc", "day": "2026-11-03", "attendee": "dana@example.com" });
        assert!(same_input(&recorded, &routed));
    }

    #[test]
    fn a_whole_float_matches_the_integer() {
        assert!(same_input(&json!({ "duration": 30 }), &json!({ "duration": 30.0 })));
        assert!(!same_input(&json!({ "duration": 30 }), &json!({ "duration": 30.5 })));
    }

    #[test]
    fn a_string_duration_does_not_match_a_number() {
        assert!(!same_input(&json!({ "duration": 30 }), &json!({ "duration": "30" })));
    }

    #[test]
    fn differences_name_each_changed_leaf() {
        let recorded = json!({ "state": "done", "output": { "status": "booked", "turns": 3, "at": [1, 2] } });
        let replayed = json!({ "state": "done", "output": { "status": "failed", "turns": 3.0, "at": [1, 3], "extra": true } });
        assert_eq!(differences(&recorded, &replayed), ["/output/at/1", "/output/extra", "/output/status"]);
        assert!(differences(&recorded, &recorded).is_empty());
        assert_eq!(differences(&json!({ "a": [1] }), &json!({ "a": [1, 2] })), ["/a"]);
    }

    #[test]
    fn a_different_message_history_does_not_match() {
        let recorded = json!({ "turn": 2, "messages": [{ "role": "tool", "result": { "error": "invocation_failed: boom" } }] });
        let replayed = json!({ "turn": 2, "messages": [{ "role": "tool", "result": { "error": "invocation_failed: other" } }] });
        assert!(!same_input(&recorded, &replayed));
    }
}
