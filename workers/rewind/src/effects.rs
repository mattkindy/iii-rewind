//! The effects a function declares in its metadata, such as `read-only` or `irreversible`, parsed
//! once from the function list or from a request's method. What Rewind does with a call because
//! of them is decided in the replay's decision module.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Effect {
    Pure,
    ReadOnly,
    External,
    Writes,
    Irreversible,
    /// An effect Rewind doesn't know, such as a typo, kept as written so the page shows it.
    Unknown(String),
}

const NAMED: [(Effect, &str); 5] = [
    (Effect::Pure, "pure"),
    (Effect::ReadOnly, "read-only"),
    (Effect::External, "external"),
    (Effect::Writes, "writes"),
    (Effect::Irreversible, "irreversible"),
];

impl Effect {
    pub fn parse(text: &str) -> Self {
        NAMED
            .iter()
            .find(|(_, name)| *name == text)
            .map(|(effect, _)| effect.clone())
            .unwrap_or_else(|| Effect::Unknown(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        if let Effect::Unknown(text) = self {
            return text;
        }

        NAMED.iter().find(|(effect, _)| effect == self).map(|(_, name)| *name).unwrap_or_default()
    }
}

impl From<&str> for Effect {
    fn from(text: &str) -> Self {
        Effect::parse(text)
    }
}

impl Serialize for Effect {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Effect {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Effect::parse(&String::deserialize(deserializer)?))
    }
}

/// Effects as a function's metadata lists them. Anything in the list that is not text is left out.
pub fn from_metadata(list: &[serde_json::Value]) -> Vec<Effect> {
    list.iter().filter_map(|effect| effect.as_str().map(Effect::parse)).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn every_effect_reads_back_as_it_was_written_even_one_rewind_does_not_know() {
        for text in ["pure", "read-only", "external", "writes", "irreversible", "read-onyl"] {
            assert_eq!(Effect::parse(text).as_str(), text);
            assert_eq!(serde_json::to_value(Effect::parse(text)).unwrap(), json!(text));
        }

        assert_eq!(Effect::parse("read-onyl"), Effect::Unknown("read-onyl".into()));
        let parsed: Vec<Effect> = serde_json::from_value(json!(["read-only", "sends-mail"])).unwrap();
        assert_eq!(parsed, [Effect::ReadOnly, Effect::Unknown("sends-mail".into())]);
        assert_eq!(from_metadata(&[json!("writes"), json!(3)]), [Effect::Writes]);
    }
}
