//! One copy of a worker as a child process: started by a small shell wrapper in a process group of
//! its own, with `III_NAMESPACE` set to its namespace, and stopped by signalling that group. The
//! wrapper also stops the copy when Rewind exits for any reason, so a copy never outlives Rewind.

use std::{collections::HashSet, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, ChildStdin, Command},
    sync::watch,
};

use crate::{
    app::App,
    code::CodeVersion,
    error::{Error, Result},
    sources::WorkerSource,
};

const COPY_STOP_GRACE: Duration = Duration::from_secs(3);

/// What the preload prints in a copy once its HTTP server listens, followed by `host:port`.
const LISTENING_LINE: &str = "REWIND_LISTENING ";

// The wrapper reads its stdin, a pipe only Rewind writes to, and stops the copy when the pipe
// closes. The watcher signals the whole group, so a start command that forks, such as `npm start`,
// takes its children down too. It ignores TERM to live long enough to send the final KILL.
const WRAPPER: &str = r#"exec 3<&0
eval "exec $REWIND_COPY_START" 3<&- &
child=$!
(
  trap '' TERM
  read -r _ <&3
  kill -s TERM -- "-$$" 2>/dev/null
  for _ in 1 2 3; do kill -0 "$child" 2>/dev/null || exit 0; sleep 1; done
  kill -s KILL -- "-$$" 2>/dev/null
) &
watcher=$!
exec 3<&-
signaled=
trap 'signaled=1; kill -TERM "$child" 2>/dev/null' TERM INT HUP
wait "$child"
status=$?
[ -n "$signaled" ] || kill -KILL "$watcher" 2>/dev/null
exit "$status"
"#;

/// A running copy of a worker, and what Rewind knows about it.
pub struct Copy {
    child: Child,
    _keepalive: Option<ChildStdin>,
    group: i32,
    stopped: bool,
    /// Read before the copy started, so an edit made while it loads still counts as a change.
    pub(super) code: CodeVersion,
    listening: watch::Receiver<Option<String>>,
    /// The copy's functions the engine has listed in its namespace since it started.
    pub(super) listed: HashSet<String>,
}

impl Copy {
    /// A copy of the worker in `source.dir`, started with its own start command.
    pub fn spawn_worker(app: &App, source: &WorkerSource, namespace: &str, code: CodeVersion) -> Result<Self> {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(WRAPPER)
            .current_dir(&source.dir)
            .env("REWIND_COPY_START", &source.start)
            .env("III_NAMESPACE", namespace)
            .env("III_URL", &app.config.url)
            // The preload in the copy asks Rewind about each fetch instead of recording it.
            .env("REWIND_CAPTURE", "replay")
            // Compose sets this for Rewind itself. The copy should keep the worker name in its code.
            .env_remove("III_WORKER_NAME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| Error::CopySpawn(format!("could not start the copy in {}: {error}", source.dir.display())))?;
        let group = child.id().map(|pid| pid as i32).unwrap_or(0);
        let (heard, listening) = watch::channel(None);
        forward(child.stdout.take(), namespace, Some(heard));
        forward(child.stderr.take(), namespace, None);
        eprintln!(
            "rewind: started a copy of {} in {namespace} (process group {group}) on code {}",
            source.names.first().map(String::as_str).unwrap_or("a worker"),
            code.version
        );
        Ok(Self {
            _keepalive: child.stdin.take(),
            child,
            group,
            stopped: false,
            code,
            listening,
            listed: HashSet::new(),
        })
    }

    /// The address the copy's HTTP server listens on, which its preload prints once it does.
    pub async fn listening(&mut self, timeout: Duration) -> Result<String> {
        let waited = tokio::time::timeout(timeout, self.listening.wait_for(Option::is_some)).await;
        match waited {
            Ok(Ok(address)) => Ok(address.clone().unwrap_or_default()),
            _ => Err(Error::CopyNotListening(format!(
                "the copy's server did not start listening within {timeout:?}"
            ))),
        }
    }

    pub fn exit_status(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            Ok(None) => None,
            Err(error) => Some(error.to_string()),
        }
    }

    /// The wrapper shell exits as soon as it is signalled, so this waits for the whole group,
    /// which lets the copy's preload send its last spans, before the final kill.
    pub async fn stop(mut self) {
        signal_group(self.group, libc::SIGTERM);
        let _ = tokio::time::timeout(COPY_STOP_GRACE, self.child.wait()).await;
        let _ = tokio::time::timeout(COPY_STOP_GRACE, group_gone(self.group)).await;
        signal_group(self.group, libc::SIGKILL);
        let _ = tokio::time::timeout(COPY_STOP_GRACE, self.child.wait()).await;
        self.stopped = true;
    }
}

async fn group_gone(group: i32) {
    while group > 0 && group_alive(group) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn group_alive(group: i32) -> bool {
    // SAFETY: signal 0 only checks that the group exists; it sends nothing.
    unsafe { libc::killpg(group, 0) == 0 }
}

impl Drop for Copy {
    fn drop(&mut self) {
        if !self.stopped {
            signal_group(self.group, libc::SIGKILL);
        }
    }
}

fn signal_group(group: i32, signal: i32) {
    if group > 0 {
        // SAFETY: killpg only sends a signal; a group that is already gone returns ESRCH.
        unsafe {
            libc::killpg(group, signal);
        }
    }
}

/// Prints the copy's output, and passes on the address from its preload's listening line.
fn forward(stream: Option<impl AsyncRead + Unpin + Send + 'static>, namespace: &str, heard: Option<watch::Sender<Option<String>>>) {
    let Some(stream) = stream else {
        return;
    };

    let prefix = format!("[copy {namespace}]");
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let (Some(heard), Some(address)) = (&heard, line.strip_prefix(LISTENING_LINE)) {
                let _ = heard.send(Some(address.trim().to_string()));
            }

            eprintln!("{prefix} {line}");
        }
    });
}
