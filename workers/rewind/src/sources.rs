//! Where each worker's code lives and how to start it: the folder from its `path://` entry in
//! worker-compose.yaml, and the start command from its iii.worker.yaml, or its package.json
//! when the manifest has none. A worker is found by its container name or its manifest's name.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerSource {
    /// The container name, then the manifest's name if it differs.
    pub names: Vec<String>,
    pub dir: PathBuf,
    pub start: String,
}

impl WorkerSource {
    pub fn is(&self, worker: &str) -> bool {
        self.names.iter().any(|name| name == worker)
    }
}

#[derive(Deserialize)]
struct Compose {
    #[serde(default)]
    containers: BTreeMap<String, Container>,
}

#[derive(Deserialize)]
struct Container {
    #[serde(default)]
    worker: Option<String>,
}

#[derive(Deserialize, Default)]
struct Manifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    scripts: Scripts,
}

#[derive(Deserialize, Default)]
struct Scripts {
    #[serde(default)]
    start: Option<String>,
}

const LOCAL_WORKER: &str = "path://";

/// A packaged worker such as the ADE has no folder to start a copy from, so it is left out.
fn local_workers(compose: &str, project_dir: &Path) -> serde_yaml::Result<Vec<(String, PathBuf)>> {
    let parsed: Compose = serde_yaml::from_str(compose)?;
    Ok(parsed
        .containers
        .into_iter()
        .filter_map(|(name, container)| {
            let path = container.worker?.strip_prefix(LOCAL_WORKER)?.to_string();
            Some((name, project_dir.join(path)))
        })
        .collect())
}

fn manifest(dir: &Path) -> Manifest {
    std::fs::read_to_string(dir.join("iii.worker.yaml"))
        .ok()
        .and_then(|text| serde_yaml::from_str(&text).ok())
        .unwrap_or_default()
}

fn package_start(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_str(&text).ok()?;
    package["scripts"]["start"].as_str().map(str::to_string)
}

fn source_of(name: String, dir: PathBuf) -> Option<WorkerSource> {
    let manifest = manifest(&dir);
    let start = manifest.scripts.start.or_else(|| package_start(&dir))?;
    let mut names = vec![name];
    if let Some(own) = manifest.name
        && !names.contains(&own)
    {
        names.push(own);
    }

    Some(WorkerSource { names, dir, start })
}

/// Every local worker in the compose file that says how to start it.
pub fn read(compose_file: &Path, project_dir: &Path) -> Result<Vec<WorkerSource>> {
    let unreadable = |error: &dyn std::fmt::Display| Error::NoCompose(format!("{}: {error}", compose_file.display()));
    let text = std::fs::read_to_string(compose_file).map_err(|error| unreadable(&error))?;
    let workers = local_workers(&text, project_dir).map_err(|error| unreadable(&error))?;
    Ok(workers
        .into_iter()
        .filter_map(|(name, dir)| source_of(name, dir))
        .collect())
}

pub fn find(sources: Vec<WorkerSource>, worker: &str) -> Result<WorkerSource> {
    sources.into_iter().find(|source| source.is(worker)).ok_or_else(|| {
        Error::NotFound(format!("worker-compose.yaml has no local worker {worker:?} with a start command"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPOSE: &str = r#"
engine:
  url: ws://127.0.0.1:49334
containers:
  tools:
    worker: path://./workers/tools
    restart: always
  agent:
    worker: path://./workers/agent
    start_after: [clock, model, tools]
  ade:
    worker: package://ade
    version: "latest"
"#;

    #[test]
    fn local_workers_come_from_their_path_and_packaged_ones_are_left_out() {
        let found = local_workers(COMPOSE, Path::new("/project")).unwrap();
        assert_eq!(
            found,
            vec![
                ("agent".to_string(), PathBuf::from("/project/./workers/agent")),
                ("tools".to_string(), PathBuf::from("/project/./workers/tools")),
            ]
        );
    }

    #[test]
    fn the_start_command_comes_from_the_manifest_and_then_package_json() {
        let dir = std::env::temp_dir().join(format!("rewind-sources-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("python")).unwrap();
        std::fs::create_dir_all(dir.join("node")).unwrap();
        std::fs::write(
            dir.join("python").join("iii.worker.yaml"),
            "name: calendar\nscripts:\n  install: uv venv\n  start: env PYTHONPATH=x .venv/bin/python src/main.py\n",
        )
        .unwrap();
        std::fs::write(dir.join("node").join("iii.worker.yaml"), "name: node\n").unwrap();
        std::fs::write(dir.join("node").join("package.json"), r#"{ "scripts": { "start": "node src/worker.ts" } }"#).unwrap();

        let python = source_of("tools".into(), dir.join("python")).unwrap();
        assert_eq!(python.start, "env PYTHONPATH=x .venv/bin/python src/main.py");
        assert!(python.is("tools") && python.is("calendar"));
        assert_eq!(source_of("node".into(), dir.join("node")).unwrap().start, "node src/worker.ts");
        assert_eq!(source_of("gone".into(), dir.join("missing")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
