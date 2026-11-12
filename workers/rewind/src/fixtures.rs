//! Tests saved from forks. A fixture says the entry, its input, every call the fork made with the
//! input it sent and the answer it got, and how the run should end. Running one replays it with no
//! live calls, and it diverges at the first call that sends another input or that the file lacks.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use crate::{
    app::App,
    catalog::Catalog,
    copies::claim,
    error::{Error, Result},
    forks::ForkRecord,
    namespaces,
    json::{differences, normalize_input},
    replay::{self, Policy, Session},
    types::{Answer, At, Call, Hold, Outcome, Source, Step},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fixture {
    pub entry: String,
    pub input: Value,
    pub answers: Vec<FixtureAnswer>,
    pub expect: Expect,
}

/// What a saved answer has to match besides its place and function.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Matching {
    /// The input the call sends, normalized the way a replay compares inputs.
    #[default]
    Input,
    /// Nothing else. Someone wrote `"match": "function"` in the file for a call whose input changes
    /// from run to run.
    Function,
}

impl Matching {
    fn is_input(&self) -> bool {
        *self == Matching::Input
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureAnswer {
    pub seq: u32,
    /// For a call inside another call, its place under each caller, as in a fork's calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    /// What the call sent. A file saved before tests compared inputs has none.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, rename = "match", skip_serializing_if = "Matching::is_input")]
    pub matching: Matching,
    pub answer: Answer,
    pub source: Source,
    /// Present when the caller gave up on this call, so the test times out the same way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<Hold>,
}

impl FixtureAnswer {
    fn at(&self) -> At {
        At::of(self.seq, &self.path)
    }
}

/// Keeps an input of `null` apart from a missing one, which serde would read as none for both.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Expect {
    Status { status: String },
    Throws { throws: String },
    Output { output: Value },
}

pub fn expect_for(outcome: &Outcome) -> Result<Expect> {
    match outcome {
        Outcome::Done { output } => Ok(match output["status"].as_str() {
            Some(status) => Expect::Status {
                status: status.to_string(),
            },
            None => Expect::Output {
                output: output.clone(),
            },
        }),
        Outcome::Crashed { error } => Ok(Expect::Throws {
            throws: error.message.clone(),
        }),
        Outcome::Paused { need } => Err(Error::ForkPaused(format!(
            "the fork is waiting for an answer to {} at seq {}",
            need.function_id, need.seq
        ))),
    }
}

pub fn passes(expect: &Expect, outcome: &Outcome) -> bool {
    match (expect, outcome) {
        (Expect::Status { status }, Outcome::Done { output }) => output["status"].as_str() == Some(status),
        (Expect::Output { output: expected }, Outcome::Done { output }) => expected == output,
        (Expect::Throws { throws }, Outcome::Crashed { error }) => &error.message == throws,
        _ => false,
    }
}

pub fn fixture_of(fork: &ForkRecord, entry: &str, input: Value) -> Result<Fixture> {
    Ok(Fixture {
        entry: entry.to_string(),
        input,
        answers: fork
            .steps
            .iter()
            .map(|step| FixtureAnswer {
                seq: step.call.seq,
                path: step.call.path.clone(),
                function_id: step.call.function_id.clone(),
                input: Some(normalize_input(&step.call.input)),
                matching: Matching::Input,
                answer: step.call.answer.clone(),
                source: step.call.source,
                hold: step.hold.clone(),
            })
            .collect(),
        expect: expect_for(&fork.outcome)?,
    })
}

pub fn file_name(name: Option<&str>, fork: &ForkRecord) -> String {
    let short_run: String = fork.run_id.chars().take(8).collect();
    let wanted = name
        .map(str::to_string)
        .unwrap_or_else(|| format!("run-{short_run}-{}", fork.fork_id));
    let cleaned: String = wanted
        .trim_end_matches(".json")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("{}.json", cleaned.trim_matches('-'))
}

pub async fn save(app: &App, fork_id: &str, name: Option<&str>) -> Result<Value> {
    let fork = app.fork_record(fork_id)?;
    let (run, _) = app.run(&fork.run_id)?;
    let input = normalize_input(run.input.as_ref().unwrap_or(&Value::Null));
    let fixture = fixture_of(&fork, &run.function_id, input)?;
    let path = app.config.tests_dir.join(file_name(name, &fork));
    let write_error = |error: std::io::Error| Error::Write(format!("{}: {error}", path.display()));
    std::fs::create_dir_all(&app.config.tests_dir).map_err(write_error)?;
    let text = serde_json::to_string_pretty(&fixture).map_err(|error| Error::Write(error.to_string()))?;
    std::fs::write(&path, text + "\n").map_err(write_error)?;
    // The page shows this path, so it leaves out the machine's folders, and `resolve` takes it back as is.
    let shown = path.strip_prefix(&app.config.project_dir).unwrap_or(&path);
    Ok(json!({ "path": shown.display().to_string(), "fixture": fixture }))
}

/// An absolute path, a path from the project folder, or a test's name in the tests folder.
fn candidate(tests_dir: &Path, project_dir: &Path, path: &str) -> PathBuf {
    let given = PathBuf::from(path);
    if given.is_absolute() {
        return given;
    }

    if path.contains('/') {
        return project_dir.join(given);
    }

    let named = tests_dir.join(path);
    if named.extension().is_some() {
        return named;
    }

    named.with_extension("json")
}

/// The test at `path`, which has to be inside the tests folder, so a caller can't read other files.
fn resolve(tests_dir: &Path, project_dir: &Path, path: &str) -> Result<PathBuf> {
    let outside = || Error::BadInput(format!("{path} is not in the tests folder {}", tests_dir.display()));
    let climbs = Path::new(path).components().any(|part| part == Component::ParentDir);
    let found = candidate(tests_dir, project_dir, path);
    if climbs || !found.starts_with(tests_dir) {
        return Err(outside());
    }

    // A link inside the folder can still point out of it.
    if let (Ok(target), Ok(folder)) = (found.canonicalize(), tests_dir.canonicalize())
        && !target.starts_with(folder)
    {
        return Err(outside());
    }

    Ok(found)
}

/// How a saved test ran: whether it passed, the ending it expected and the one it got, and where
/// it diverged when the code made a call the file has no answer for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestRun {
    pub pass: bool,
    pub expected: Expect,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diverged: Option<Diverged>,
}

/// The call a test paused at, what the file has at that place, and each part of the input that
/// differs from the saved one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diverged {
    pub seq: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    pub input: Value,
    /// None when the file has no call at that place, because the code now makes more calls than
    /// the fork did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<SavedCall>,
    pub differences: Vec<Difference>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedCall {
    pub function_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

/// One field of the input, as a JSON pointer, with the saved value and the one the call sent. A
/// field only one of them has leaves the other out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Difference {
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent: Option<Value>,
}

/// Where a paused test left its file behind, or none when it ran to an ending.
pub fn diverged(fixture: &Fixture, outcome: &Outcome) -> Option<Diverged> {
    let Outcome::Paused { need } = outcome else {
        return None;
    };
    let saved = fixture.answers.iter().find(|answer| answer.at() == need.at());
    Some(Diverged {
        seq: need.seq,
        path: need.path.clone(),
        function_id: need.function_id.clone(),
        input: need.input.clone(),
        saved: saved.map(|answer| SavedCall {
            function_id: answer.function_id.clone(),
            input: answer.input.clone(),
        }),
        differences: saved
            .filter(|answer| answer.function_id == need.function_id)
            .and_then(|answer| answer.input.as_ref())
            .map(|input| differences_between(input, &need.input))
            .unwrap_or_default(),
    })
}

fn differences_between(saved: &Value, sent: &Value) -> Vec<Difference> {
    differences(saved, sent)
        .into_iter()
        .map(|field| Difference {
            saved: saved.pointer(&field).cloned(),
            sent: sent.pointer(&field).cloned(),
            field,
        })
        .collect()
}

/// A file saved before tests compared inputs would pass whatever its calls send, so it is refused
/// until someone saves it again or marks the answers that should match on function alone.
fn without_input(fixture: &Fixture, path: &Path) -> Result<()> {
    let Some(answer) = fixture
        .answers
        .iter()
        .find(|answer| answer.input.is_none() && answer.matching == Matching::Input)
    else {
        return Ok(());
    };

    Err(Error::BadFixture(format!(
        "{}: the answer at seq {} ({}) has no input to compare. Save the test again from its fork, or add \"match\": \"function\" to that answer",
        path.display(),
        answer.at(),
        answer.function_id
    )))
}

/// The answers a test's run starts with, each at its place with the input it was saved with.
fn answers_of(catalog: &Catalog, fixture: &Fixture) -> BTreeMap<At, Step> {
    fixture
        .answers
        .iter()
        .map(|answer| {
            let (worker, effects) = catalog.describe(&answer.function_id);
            let at = answer.at();
            let call = Call {
                worker,
                effects,
                input: answer.input.clone().unwrap_or(Value::Null),
                ..Call::new(&at, answer.function_id.clone(), answer.answer.clone(), answer.source)
            };
            let step = Step {
                hold: answer.hold.clone(),
                ..Step::new(call.with_origin())
            };
            (at, step)
        })
        .collect()
}

fn function_only(fixture: &Fixture) -> BTreeSet<At> {
    fixture
        .answers
        .iter()
        .filter(|answer| answer.matching == Matching::Function)
        .map(FixtureAnswer::at)
        .collect()
}

pub async fn run(app: &Arc<App>, path: &str) -> Result<TestRun> {
    let path = resolve(&app.config.tests_dir, &app.config.project_dir, path)?;
    let text = std::fs::read_to_string(&path).map_err(|error| Error::NotFound(format!("{}: {error}", path.display())))?;
    // A refusal is printed where people share logs, so it leaves out the machine's folders.
    let shown = path.strip_prefix(&app.config.project_dir).unwrap_or(&path);
    let fixture: Fixture =
        serde_json::from_str(&text).map_err(|error| Error::BadFixture(format!("{}: {error}", shown.display())))?;
    without_input(&fixture, shown)?;

    let session = Session::new(Policy::of_test(function_only(&fixture)), Vec::new(), answers_of(&app.catalog, &fixture));
    let copies = app.copies_for(&fixture.entry, &[])?;
    let namespace = namespaces::fork(claim(app, &copies).await?);
    let space = app.spaces.open(app, &namespace, &copies).await?;
    let ran = replay::run_in(app, &space, &fixture.entry, fixture.input.clone(), session).await;
    app.spaces.close(&namespace).await;
    let outcome = ran?.outcome;
    Ok(TestRun {
        pass: passes(&fixture.expect, &outcome),
        diverged: diverged(&fixture, &outcome),
        expected: fixture.expect,
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        replay::{
            Decision,
            testing::{decide, no_runs, step},
        },
        types::{ErrorAnswer, Mode, Need, PauseReason},
    };

    fn fork_of(steps: Vec<Step>, outcome: Outcome) -> ForkRecord {
        ForkRecord {
            fork_id: "f7".into(),
            number: 7,
            run_id: "3f2a9c10-aaaa".into(),
            parent: None,
            edit_at: None,
            namespace: "rewind-f7".into(),
            mode: Mode::Debug,
            auto_read: false,
            auto: false,
            stops: Vec::new(),
            copy: Vec::new(),
            answers: BTreeMap::new(),
            steps,
            outcome,
            created_at_ms: 0,
            code: None,
            trace_id: None,
            span_id: None,
            rerun: None,
        }
    }

    const ASKED: &str = "Book 45 minutes with Omar next Wednesday afternoon";

    fn asking(content: &str) -> Value {
        json!({ "turn": 1, "messages": [{ "role": "user", "content": content }] })
    }

    /// A fork that read the clock, asked the model once and booked.
    fn booked_fork() -> ForkRecord {
        let steps = vec![
            step(0, "clock::now", json!({}), Answer::value(json!({ "now": "2026-11-12T00:48:20-06:00" })), Source::Recorded),
            step(1, "model::complete", asking(ASKED), Answer::value(json!({ "text": "Booked", "status": "booked" })), Source::Recorded),
        ];
        fork_of(steps, Outcome::Done { output: json!({ "status": "booked", "reply": "Booked", "turns": 1 }) })
    }

    /// The fork saved as a test and read back from its file, the way `rewind::test` reads it.
    fn saved(fork: &ForkRecord) -> Value {
        serde_json::to_value(fixture_of(fork, "agent::run", json!({ "request": ASKED })).unwrap()).unwrap()
    }

    fn read(file: Value) -> Fixture {
        serde_json::from_str(&serde_json::to_string_pretty(&file).unwrap()).unwrap()
    }

    fn test_session(fixture: &Fixture) -> Session {
        Session::new(Policy::of_test(function_only(fixture)), Vec::new(), answers_of(&Catalog::default(), fixture))
    }

    fn paused_at(seq: u32, function_id: &str, input: Value) -> Outcome {
        Outcome::Paused {
            need: Need {
                seq,
                path: Vec::new(),
                function_id: function_id.into(),
                input,
                effects: Vec::new(),
                choices: Vec::new(),
                reason: PauseReason::NoAnswer,
                response_format: None,
                trace_id: None,
                span_id: None,
            },
        }
    }

    #[test]
    fn a_saved_test_answers_every_call_that_sends_what_it_saved() {
        let fixture = read(saved(&booked_fork()));
        let session = test_session(&fixture);
        assert!(matches!(decide(&session, &no_runs(), 0, "clock::now", &json!({}), &[]), Decision::Answer(_)));
        assert!(matches!(decide(&session, &no_runs(), 1, "model::complete", &asking(ASKED), &[]), Decision::Answer(_)));
        let booked = Outcome::Done { output: json!({ "status": "booked" }) };
        assert!(passes(&fixture.expect, &booked));
        assert_eq!(diverged(&fixture, &booked), None);
    }

    #[test]
    fn a_saved_test_fails_as_diverged_when_the_code_sends_another_input() {
        let fixture = read(saved(&booked_fork()));
        let changed = format!("{ASKED} (asked by matt)");
        let paused = decide(&test_session(&fixture), &no_runs(), 1, "model::complete", &asking(&changed), &[]);
        assert_eq!(paused, Decision::Pause(PauseReason::NoAnswer));

        let outcome = paused_at(1, "model::complete", asking(&changed));
        assert!(!passes(&fixture.expect, &outcome));
        let diverged = diverged(&fixture, &outcome).unwrap();
        assert_eq!(diverged.saved.map(|saved| saved.function_id).as_deref(), Some("model::complete"));
        let difference = Difference {
            field: "/messages/0/content".into(),
            saved: Some(json!(ASKED)),
            sent: Some(json!(changed)),
        };
        assert_eq!(diverged.differences, [difference]);
    }

    #[test]
    fn a_call_the_file_has_no_answer_for_diverges_with_nothing_saved_there() {
        let fixture = read(saved(&booked_fork()));
        let diverged = diverged(&fixture, &paused_at(2, "email::send", json!({ "to": "omar@example.com" }))).unwrap();
        assert_eq!((diverged.seq, diverged.saved, diverged.differences), (2, None, Vec::new()));
    }

    #[test]
    fn an_answer_marked_function_only_in_the_file_takes_another_input() {
        let mut file = saved(&booked_fork());
        file["answers"][1]["match"] = json!("function");
        let fixture = read(file);
        let changed = asking(&format!("{ASKED} (asked by matt)"));
        assert!(matches!(decide(&test_session(&fixture), &no_runs(), 1, "model::complete", &changed, &[]), Decision::Answer(_)));
        assert_eq!(serde_json::to_value(&fixture).unwrap()["answers"][1]["match"], "function");
        assert!(serde_json::to_value(&fixture).unwrap()["answers"][0].get("match").is_none());
    }

    #[test]
    fn a_file_saved_before_tests_compared_inputs_is_refused_until_it_says_how_to_match() {
        let mut file = saved(&booked_fork());
        for answer in file["answers"].as_array_mut().unwrap() {
            answer.as_object_mut().unwrap().remove("input");
        }

        let refused = without_input(&read(file.clone()), Path::new("tests/rewind/booked.json")).unwrap_err();
        assert_eq!(refused.code(), "REWIND_BAD_FIXTURE");
        assert!(refused.to_string().contains("\"match\": \"function\""), "{refused}");
        for answer in file["answers"].as_array_mut().unwrap() {
            answer["match"] = json!("function");
        }

        assert!(without_input(&read(file), Path::new("tests/rewind/booked.json")).is_ok());
    }

    #[test]
    fn a_saved_input_of_null_is_kept_apart_from_a_missing_one() {
        let answer = |input: Option<Value>| {
            let mut answer = json!({ "seq": 0, "function_id": "clock::now", "answer": { "value": {} }, "source": "recorded" });
            if let Some(input) = input {
                answer["input"] = input;
            }

            serde_json::from_value::<FixtureAnswer>(answer).unwrap().input
        };
        assert_eq!(answer(Some(Value::Null)), Some(Value::Null));
        assert_eq!(answer(None), None);
    }

    #[test]
    fn a_booked_run_expects_its_status() {
        let outcome = Outcome::Done {
            output: json!({ "status": "booked", "reply": "Booked", "turns": 3 }),
        };
        let expect = expect_for(&outcome).unwrap();
        assert_eq!(expect, Expect::Status { status: "booked".into() });
        assert!(passes(&expect, &outcome));
        assert!(!passes(&expect, &Outcome::Done { output: json!({ "status": "failed" }) }));
    }

    #[test]
    fn a_crash_expects_the_same_message() {
        let outcome = Outcome::Crashed {
            error: ErrorAnswer {
                code: Some("invocation_failed".into()),
                message: "Unterminated string in JSON at position 40".into(),
            },
        };
        let expect = expect_for(&outcome).unwrap();
        assert!(passes(&expect, &outcome));
        assert!(!passes(&expect, &Outcome::Done { output: json!({}) }));
    }

    #[test]
    fn a_paused_fork_cannot_be_saved() {
        let outcome = Outcome::Paused {
            need: Need {
                seq: 2,
                path: Vec::new(),
                function_id: "email::send".into(),
                input: json!({}),
                effects: vec![],
                choices: vec![],
                reason: crate::types::PauseReason::NoAnswer,
                response_format: None,
                trace_id: None,
                span_id: None,
            },
        };
        assert!(expect_for(&outcome).is_err());
    }

    #[test]
    fn expectations_parse_from_the_fixture_file() {
        let status: Expect = serde_json::from_value(json!({ "status": "booked" })).unwrap();
        assert_eq!(status, Expect::Status { status: "booked".into() });
        let throws: Expect = serde_json::from_value(json!({ "throws": "boom" })).unwrap();
        assert_eq!(throws, Expect::Throws { throws: "boom".into() });
    }

    #[test]
    fn file_names_are_tidied() {
        let fork = fork_of(Vec::new(), Outcome::Done { output: json!({}) });
        assert_eq!(file_name(None, &fork), "run-3f2a9c10-f7.json");
        assert_eq!(file_name(Some("Repair the JSON/args"), &fork), "repair-the-json-args.json");
        assert_eq!(file_name(Some("booked.json"), &fork), "booked.json");
    }

    /// A project folder with one saved test, a file beside the tests folder, and a link out of it.
    fn project(name: &str) -> (PathBuf, PathBuf) {
        let project = std::env::temp_dir().join(format!("rewind-fixtures-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        let tests = project.join("tests").join("rewind");
        std::fs::create_dir_all(&tests).unwrap();
        std::fs::write(tests.join("booked.json"), "{}\n").unwrap();
        std::fs::write(project.join("secret.json"), "{}\n").unwrap();
        std::os::unix::fs::symlink(project.join("secret.json"), tests.join("link.json")).unwrap();
        (project, tests)
    }

    #[test]
    fn a_test_is_found_by_name_or_by_a_path_inside_the_tests_folder() {
        let (project, tests) = project("inside");
        let booked = tests.join("booked.json");
        assert_eq!(resolve(&tests, &project, "booked").unwrap(), booked);
        assert_eq!(resolve(&tests, &project, "booked.json").unwrap(), booked);
        assert_eq!(resolve(&tests, &project, "tests/rewind/booked.json").unwrap(), booked);
        assert_eq!(resolve(&tests, &project, &booked.to_string_lossy()).unwrap(), booked);
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn a_path_outside_the_tests_folder_is_refused() {
        let (project, tests) = project("outside");
        let secret = project.join("secret.json");
        for path in [
            "../secret.json".to_string(),
            "tests/rewind/../../secret.json".to_string(),
            "secret.json/../../../etc/passwd".to_string(),
            "workers/agent/package.json".to_string(),
            "/etc/passwd".to_string(),
            secret.to_string_lossy().to_string(),
            "link.json".to_string(),
        ] {
            let refused = resolve(&tests, &project, &path).unwrap_err();
            assert_eq!(refused.code(), "REWIND_BAD_INPUT", "{path}: {refused}");
        }

        std::fs::remove_dir_all(&project).unwrap();
    }
}
