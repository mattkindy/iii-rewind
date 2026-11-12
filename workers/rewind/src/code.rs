//! The version of the code under test, a short hash of the files in the target folder.
//! Installed packages, build output and the files Rewind writes are left out. A copy keeps
//! the version it started with, so Rewind can restart it after someone edits the code.

use std::{
    collections::HashMap,
    fs,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::{
    app::App,
    error::{Error, Result},
};

// A Python target writes __pycache__ the first time it imports a changed file.
const SKIPPED_DIRS: [&str; 5] = ["node_modules", ".venv", "dist", "__pycache__", ".git"];
const SHORT_LEN: usize = 12;
const WATCH_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeVersion {
    pub version: String,
    /// When the newest file in the version was last modified.
    pub changed_at_ms: u64,
}

/// The files Rewind writes. Reading one of its open databases drops Rewind's locks on it, and
/// another process can then truncate the `-shm` file SQLite has mapped, a SIGBUS in Rewind.
#[derive(Debug, Clone, Default)]
pub struct OwnFiles {
    /// Resolved paths. A file whose name only adds to one, such as `rewind.sqlite-wal`, counts too.
    files: Vec<PathBuf>,
    /// Folders where everything is Rewind's, such as saved tests.
    folders: Vec<PathBuf>,
}

impl OwnFiles {
    pub fn new(files: &[&Path], folders: &[&Path]) -> Self {
        Self {
            files: files.iter().map(|file| resolved(file)).collect(),
            folders: folders.iter().map(|folder| resolved(folder)).collect(),
        }
    }

    /// Whether Rewind wrote `path`, which has to be resolved already.
    fn contains(&self, path: &Path) -> bool {
        if self.folders.iter().any(|folder| path.starts_with(folder)) {
            return true;
        }

        let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
        self.files.iter().any(|file| {
            let own_name = file.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
            file.parent() == path.parent() && name.starts_with(own_name.as_ref())
        })
    }
}

/// The path with links and `..` resolved through its nearest folder that exists, so a file Rewind
/// hasn't written yet still matches once it has.
fn resolved(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(found) = ancestor.canonicalize() {
            return found.join(path.strip_prefix(ancestor).unwrap_or(Path::new("")));
        }
    }

    path.to_path_buf()
}

fn files_under(dir: &Path, own: &OwnFiles, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if own.contains(&path) {
            continue;
        }

        let kind = entry.file_type()?;
        if kind.is_dir() {
            let skipped = SKIPPED_DIRS.iter().any(|name| entry.file_name() == *name);
            if !skipped {
                files_under(&path, own, out)?;
            }

            continue;
        }

        if kind.is_file() {
            out.push(path);
            continue;
        }

        // A link to a folder could loop back on itself, so only links to files are followed.
        if kind.is_symlink() && path.is_file() && !own.contains(&fs::canonicalize(&path)?) {
            out.push(path);
        }
    }

    Ok(())
}

fn modified_ms(path: &Path) -> io::Result<u64> {
    let modified = fs::metadata(path)?.modified()?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0))
}

/// Hashes each file's path and contents in path order, so renaming a file changes the version too.
pub fn read(dir: &Path, own: &OwnFiles) -> io::Result<CodeVersion> {
    // Rewind's own files are found by resolved path, so a target given as `..` still leaves them out.
    let dir = dir.canonicalize()?;
    let mut files = Vec::new();
    files_under(&dir, own, &mut files)?;
    files.sort();

    let mut hasher = Sha1::new();
    let mut changed_at_ms = 0;
    for file in &files {
        let relative = file.strip_prefix(&dir).unwrap_or(file).to_string_lossy();
        let contents = fs::read(file)?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update((contents.len() as u64).to_le_bytes());
        hasher.update(&contents);
        changed_at_ms = changed_at_ms.max(modified_ms(file)?);
    }

    let hex: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(CodeVersion {
        version: hex[..SHORT_LEN].to_string(),
        changed_at_ms,
    })
}

fn unreadable(dir: &Path, error: io::Error) -> Error {
    Error::CodeUnreadable(format!("could not read the code in {}: {error}", dir.display()))
}

// Reruns back to back read the same folder many times a second, and an edit takes a person longer.
const REUSE_FOR: Duration = Duration::from_millis(500);

/// The versions of the folders copies start from, as last read, so back to back reruns hash a
/// folder at most once in `REUSE_FOR`.
#[derive(Default)]
pub struct Versions {
    read: Mutex<HashMap<PathBuf, (Instant, CodeVersion)>>,
    own: OwnFiles,
}

impl Versions {
    pub fn new(own: OwnFiles) -> Self {
        Self {
            read: Mutex::default(),
            own,
        }
    }

    /// The folder's version as read in the last `REUSE_FOR`, or read now, off the async threads.
    pub async fn of(self: &Arc<Self>, dir: &Path) -> Result<CodeVersion> {
        if let Some(version) = self.recent(dir, Instant::now()) {
            return Ok(version);
        }

        let (this, owned) = (self.clone(), dir.to_path_buf());
        tokio::task::spawn_blocking(move || this.read_now(&owned))
            .await
            .map_err(io::Error::other)
            .and_then(|read| read)
            .map_err(|error| unreadable(dir, error))
    }

    fn recent(&self, dir: &Path, now: Instant) -> Option<CodeVersion> {
        let read = self.read.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        read.get(dir)
            .filter(|(at, _)| now.saturating_duration_since(*at) < REUSE_FOR)
            .map(|(_, version)| version.clone())
    }

    fn read_now(&self, dir: &Path) -> io::Result<CodeVersion> {
        let found = read(dir, &self.own)?;
        self.read
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(dir.to_path_buf(), (Instant::now(), found.clone()));
        Ok(found)
    }
}

/// The code on disk in the target folder, read again whenever someone asks.
pub struct TargetCode {
    dir: PathBuf,
    latest: Mutex<Option<CodeVersion>>,
    /// Every read here also counts as a recent read for the copies of the worker under test.
    versions: Arc<Versions>,
}

impl TargetCode {
    pub fn new(dir: &Path, versions: Arc<Versions>) -> Self {
        Self {
            dir: dir.to_path_buf(),
            latest: Mutex::new(None),
            versions,
        }
    }

    fn read_blocking(&self) -> Result<CodeVersion> {
        let found = self.versions.read_now(&self.dir).map_err(|error| unreadable(&self.dir, error));
        *self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = found.as_ref().ok().cloned();
        found
    }

    /// Reads the folder now, off the async threads, since a target can have many files.
    pub async fn now(self: &Arc<Self>) -> Result<CodeVersion> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.read_blocking())
            .await
            .unwrap_or_else(|error| Err(Error::Internal(error.to_string())))
    }

    /// The last version read. The watcher reads the folder every second.
    pub fn latest(&self) -> Option<CodeVersion> {
        self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

/// Tells open pages when the code on disk changes, with `{ kind: "code", id: version }`.
pub fn start(app: &Arc<App>) {
    let app = app.clone();
    app.rt.clone().spawn(async move {
        let mut seen = app.target_code.now().await.ok().map(|code| code.version);
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            let now = app.target_code.now().await.ok().map(|code| code.version);
            if now == seen {
                continue;
            }

            if let Some(version) = &now {
                eprintln!("rewind: the code in {} is now version {version}", app.config.target_dir.display());
                app.changes.emit("code", version);
            }

            seen = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{spans::Spans, store::Store};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rewind-code-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("worker.ts"), "export const a = 1\n").unwrap();
        fs::write(dir.join("package.json"), "{}\n").unwrap();
        dir
    }

    fn read_all(dir: &Path) -> io::Result<CodeVersion> {
        read(dir, &OwnFiles::default())
    }

    /// Rewind's databases, capture file and saved tests, laid out inside `dir`.
    fn own_files_in(dir: &Path) -> OwnFiles {
        let data = dir.join("data");
        OwnFiles::new(
            &[&data.join("rewind.sqlite"), &data.join("spans.sqlite"), &data.join("captures.jsonl")],
            &[&dir.join("tests").join("rewind")],
        )
    }

    #[test]
    fn what_rewind_writes_inside_the_target_folder_does_not_count() {
        let dir = scratch("own");
        let own = own_files_in(&dir);
        let before = read(&dir, &own).unwrap().version;
        let data = dir.join("data");
        let store = Store::open(&data.join("rewind.sqlite")).unwrap();
        let spans = Spans::open(&data.join("spans.sqlite")).unwrap();
        store.set_counter("capture_offset", 1).unwrap();
        fs::write(data.join("captures.jsonl"), "{}\n").unwrap();
        fs::write(data.join("captures.jsonl.moved"), "{}\n").unwrap();
        fs::create_dir_all(dir.join("tests").join("rewind")).unwrap();
        fs::write(dir.join("tests").join("rewind").join("run-1.json"), "{}\n").unwrap();
        std::os::unix::fs::symlink(data.join("rewind.sqlite"), dir.join("src").join("db")).unwrap();
        assert_eq!(read(&dir.join("src").join(".."), &own).unwrap().version, before);

        store.set_counter("capture_offset", 2).unwrap();
        assert_eq!(read(&dir, &own).unwrap().version, before);

        fs::write(data.join("outbox.jsonl"), "{}\n").unwrap();
        assert_ne!(read(&dir, &own).unwrap().version, before);
        drop((store, spans));
        fs::remove_dir_all(&dir).unwrap();
    }

    // Every SQLite connection holds a read lock on this byte of the `-shm` file. A process that
    // finds it unlocked takes the file for its own and truncates it.
    const SHM_DEAD_MAN_SWITCH: i64 = 128;

    /// Whether another process sees a lock on one byte of `path`. A forked child holds none of
    /// this process's POSIX locks, so it sees them the way any other process would.
    fn another_process_sees_a_lock(path: &Path, offset: i64) -> bool {
        let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: the child calls only open, fcntl and _exit, which are safe after fork.
        unsafe {
            let child = libc::fork();
            if child == 0 {
                let fd = libc::open(path.as_ptr(), libc::O_RDWR);
                let mut lock: libc::flock = std::mem::zeroed();
                lock.l_type = libc::F_WRLCK as libc::c_short;
                lock.l_whence = libc::SEEK_SET as libc::c_short;
                lock.l_start = offset;
                lock.l_len = 1;
                if fd < 0 || libc::fcntl(fd, libc::F_GETLK, &mut lock) != 0 {
                    libc::_exit(2);
                }

                libc::_exit(if lock.l_type == libc::F_UNLCK as libc::c_short { 0 } else { 1 });
            }

            let mut status = 0;
            libc::waitpid(child, &mut status, 0);
            let seen = libc::WEXITSTATUS(status);
            assert!(seen < 2, "the child could not read the locks on {path:?}");
            seen == 1
        }
    }

    #[test]
    fn reading_a_version_keeps_rewinds_lock_on_its_database_in_the_target_folder() {
        let dir = scratch("lock");
        let store = Store::open(&dir.join("data").join("rewind.sqlite")).unwrap();
        store.set_counter("capture_offset", 1).unwrap();
        let shm = dir.join("data").join("rewind.sqlite-shm");
        assert!(another_process_sees_a_lock(&shm, SHM_DEAD_MAN_SWITCH));

        read(&dir, &own_files_in(&dir)).unwrap();
        assert!(another_process_sees_a_lock(&shm, SHM_DEAD_MAN_SWITCH));
        drop(store);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_version_follows_the_contents() {
        let dir = scratch("contents");
        let first = read_all(&dir).unwrap();
        assert_eq!(first.version.len(), SHORT_LEN);
        assert_eq!(read_all(&dir).unwrap(), first);

        fs::write(dir.join("src").join("worker.ts"), "export const a = 2\n").unwrap();
        let edited = read_all(&dir).unwrap();
        assert_ne!(edited.version, first.version);
        assert!(edited.changed_at_ms >= first.changed_at_ms);

        fs::write(dir.join("src").join("worker.ts"), "export const a = 1\n").unwrap();
        assert_eq!(read_all(&dir).unwrap().version, first.version);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn installed_packages_and_build_output_do_not_count() {
        let dir = scratch("skipped");
        let before = read_all(&dir).unwrap().version;
        for skipped in ["node_modules/iii-sdk", ".venv/lib", "dist", "src/__pycache__"] {
            fs::create_dir_all(dir.join(skipped)).unwrap();
            fs::write(dir.join(skipped).join("file.js"), "changed\n").unwrap();
        }

        assert_eq!(read_all(&dir).unwrap().version, before);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_version_read_moments_ago_is_reused_and_an_older_one_is_read_again() {
        let dir = scratch("reused");
        let versions = Versions::default();
        let first = versions.read_now(&dir).unwrap();
        fs::write(dir.join("src").join("worker.ts"), "export const a = 3\n").unwrap();
        let now = Instant::now();
        assert_eq!(versions.recent(&dir, now), Some(first.clone()));
        assert_eq!(versions.recent(&dir, now + REUSE_FOR), None);
        assert_eq!(versions.recent(&dir.join("src"), now), None);
        assert_ne!(versions.read_now(&dir).unwrap(), first);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reading_the_target_code_refreshes_the_version_its_copies_reuse() {
        let dir = scratch("target");
        let versions = Arc::new(Versions::default());
        let target = TargetCode::new(&dir, versions.clone());
        let before = target.read_blocking().unwrap();
        fs::write(dir.join("src").join("worker.ts"), "export const a = 4\n").unwrap();
        let after = target.read_blocking().unwrap();
        assert_ne!(after, before);
        assert_eq!(versions.recent(&dir, Instant::now()), Some(after));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn moving_a_file_changes_the_version() {
        let dir = scratch("moved");
        let before = read_all(&dir).unwrap().version;
        fs::rename(dir.join("src").join("worker.ts"), dir.join("worker.ts")).unwrap();
        assert_ne!(read_all(&dir).unwrap().version, before);
        fs::remove_dir_all(&dir).unwrap();
    }
}
