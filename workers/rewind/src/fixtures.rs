//! Tests saved from forks. A fixture says the entry, its input, every answer the
//! fork gave, and how the run should end. Running one replays it in a fresh
//! namespace with no recording and no live calls.

use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    app::App,
    copies::claim,
    error::{Error, Result},
    forks::ForkRecord,
    namespaces,
    json::normalize_input,
    replay::{self, Policy, Session, Unanswered},
    types::{Answer, At, Call, Hold, Mode, Outcome, Source, Step},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fixture {
    pub entry: String,
    pub input: Value,
    pub answers: Vec<FixtureAnswer>,
    pub expect: Expect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureAnswer {
    pub seq: u32,
    /// For a call inside another call, its place under each caller, as in a fork's calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    pub answer: Answer,
    pub source: Source,
    /// Present when the caller gave up on this call, so the test times out the same way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<Hold>,
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

pub async fn run(app: &Arc<App>, path: &str) -> Result<Value> {
    let path = resolve(&app.config.tests_dir, &app.config.project_dir, path)?;
    let text = std::fs::read_to_string(&path).map_err(|error| Error::NotFound(format!("{}: {error}", path.display())))?;
    let fixture: Fixture =
        serde_json::from_str(&text).map_err(|error| Error::BadFixture(format!("{}: {error}", path.display())))?;

    let answers: BTreeMap<At, Step> = fixture
        .answers
        .iter()
        .map(|answer| {
            let (worker, effects) = app.catalog.describe(&answer.function_id);
            let at = At::of(answer.seq, &answer.path);
            let call = Call {
                worker,
                effects,
                ..Call::new(&at, answer.function_id.clone(), answer.answer.clone(), answer.source)
            };
            let step = Step {
                hold: answer.hold.clone(),
                ..Step::new(call.with_origin())
            };
            (at, step)
        })
        .collect();
    let policy = Policy::new(Mode::Debug, false, Unanswered::Pause);
    let session = Session::new(policy, Vec::new(), answers);
    let copies = app.copies_for(&fixture.entry, &[])?;
    let namespace = namespaces::fork(claim(app, &copies).await?);
    let space = app.spaces.open(app, &namespace, &copies).await?;
    let ran = replay::run_in(app, &space, &fixture.entry, fixture.input.clone(), session).await;
    app.spaces.close(&namespace).await;
    let outcome = ran?.outcome;
    Ok(json!({
        "pass": passes(&fixture.expect, &outcome),
        "expected": fixture.expect,
        "outcome": outcome,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ErrorAnswer, Need};

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
        let fork = ForkRecord {
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
            steps: Vec::new(),
            outcome: Outcome::Done { output: json!({}) },
            created_at_ms: 0,
            code: None,
            trace_id: None,
            span_id: None,
            rerun: None,
        };
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
