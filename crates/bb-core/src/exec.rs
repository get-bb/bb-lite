use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::api::RunnerEventSink;
use crate::env::{ChildEnv, EnvMap};
use crate::error::{RunnerError, RunnerErrorCode, RunnerResult, fail};

const GIT_MAX_BYTES: usize = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS: u64 = 60_000;

/// Serializes async work per key, first come first served.
#[derive(Clone, Default)]
pub struct KeyedLock {
    tails: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl KeyedLock {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run<T>(&self, key: &str, work: impl Future<Output = T>) -> T {
        let lock = self.tails.lock().entry(key.to_owned()).or_default().clone();
        let result = {
            let _held = lock.lock().await;
            work.await
        };
        let mut tails = self.tails.lock();
        if Arc::strong_count(&lock) == 2 {
            tails.remove(key);
        }
        result
    }
}

/// What every workspace operation on a machine shares.
#[derive(Clone)]
pub struct Ctx {
    pub data_dir: PathBuf,
    /// Receives live events, and `script.output` without a `seq`.
    pub sink: RunnerEventSink,
    pub env: ChildEnv,
    pub lock: KeyedLock,
}

#[derive(Clone, Debug, Default)]
pub struct GitOptions {
    pub timeout_ms: Option<u64>,
    pub env: EnvMap,
    pub max_bytes: Option<usize>,
    pub allow_truncated: bool,
}

#[derive(Clone, Debug)]
pub struct GitOutput<T> {
    pub stdout: T,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

pub type GitResult = GitOutput<String>;

pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    let root = normalize(root);
    let candidate = normalize(candidate);
    candidate.starts_with(&root)
}

/// Lexical normalization, like Node's `path.resolve` on an absolute path.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn require_absolute<'a>(value: &'a str, label: &str) -> RunnerResult<&'a str> {
    if !Path::new(value).is_absolute() || value.contains('\0') {
        return fail(RunnerErrorCode::InvalidPath, format!("{label} must be an absolute path"));
    }
    Ok(value)
}

pub fn require_safe_ref(reference: &str) -> RunnerResult<&str> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "_./~^@-".contains(c);
    let safe = !reference.is_empty() && reference.chars().all(allowed) && !reference.contains("..");
    if safe && !reference.starts_with('-') {
        Ok(reference)
    } else {
        fail(RunnerErrorCode::InvalidPath, format!("Invalid git ref: {reference}"))
    }
}

const RESERVED_BRANCH_NAMES: [&str; 8] = [
    "AUTO_MERGE",
    "BISECT_HEAD",
    "CHERRY_PICK_HEAD",
    "FETCH_HEAD",
    "HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "REVERT_HEAD",
];

pub fn is_valid_git_branch_name(name: &str) -> bool {
    let forbidden = |c: char| c <= '\u{1f}' || c == '\u{7f}' || "\\:~^?*[ \t".contains(c);
    !name.is_empty()
        && !name.trim().is_empty()
        && !name.starts_with('-')
        && !name.starts_with('/')
        && name != "@"
        && !RESERVED_BRANCH_NAMES.contains(&name)
        && !name.chars().any(forbidden)
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.ends_with('/')
        && !name.ends_with('.')
        && name
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

pub fn require_branch_name(name: &str) -> RunnerResult<&str> {
    if is_valid_git_branch_name(name) {
        Ok(name)
    } else {
        fail(RunnerErrorCode::InvalidPath, format!("Invalid git branch name: {name}"))
    }
}

pub async fn path_exists(target: impl AsRef<Path>) -> bool {
    tokio::fs::metadata(target).await.is_ok()
}

async fn read_capped(mut stream: impl AsyncRead + Unpin, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return (kept, false),
            Ok(read) => {
                if kept.len() + read > cap {
                    kept.extend_from_slice(&chunk[..cap - kept.len()]);
                    return (kept, true);
                }
                kept.extend_from_slice(&chunk[..read]);
            }
        }
    }
}

async fn exec_git(
    ctx: &Ctx,
    cwd: &Path,
    args: &[String],
    options: &GitOptions,
    allow_failure: bool,
) -> RunnerResult<GitOutput<Vec<u8>>> {
    let mut env = (ctx.env)().await;
    env.insert("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned());
    env.extend(options.env.clone());
    let command_text = format!("git {}", args.join(" "));
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).env_clear().envs(&env);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let missing = matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            );
            if !missing {
                return Err(RunnerError::failed(format!("{command_text} failed: {error}")));
            }
            let is_directory = tokio::fs::metadata(cwd).await.is_ok_and(|meta| meta.is_dir());
            return if is_directory {
                fail(RunnerErrorCode::MissingExecutable, "git is not installed")
            } else {
                fail(RunnerErrorCode::PathNotFound, format!("Not a directory: {}", cwd.display()))
            };
        }
    };
    let cap = options.max_bytes.unwrap_or(GIT_MAX_BYTES);
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let timeout = Duration::from_millis(options.timeout_ms.unwrap_or(GIT_TIMEOUT_MS));
    let run = async {
        let ((stdout, stdout_over), (stderr, stderr_over)) =
            tokio::join!(read_capped(stdout, cap), read_capped(stderr, cap));
        if stdout_over || stderr_over {
            let _ = child.start_kill();
        }
        let status = child.wait().await;
        (stdout, stderr, stdout_over || stderr_over, status)
    };
    let Ok((stdout, stderr, over, status)) = tokio::time::timeout(timeout, run).await else {
        return Err(RunnerError::retryable(
            RunnerErrorCode::Failed,
            format!("{command_text} timed out"),
        ));
    };
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    if over {
        return if options.allow_truncated {
            Ok(GitOutput { stdout, stderr, exit_code: 0, truncated: true })
        } else {
            fail(RunnerErrorCode::FileTooLarge, format!("{command_text} output is too large"))
        };
    }
    let status =
        status.map_err(|error| RunnerError::failed(format!("{command_text} failed: {error}")))?;
    match status.code() {
        Some(0) => Ok(GitOutput { stdout, stderr, exit_code: 0, truncated: false }),
        Some(code) if allow_failure => {
            Ok(GitOutput { stdout, stderr, exit_code: code, truncated: false })
        }
        _ if stderr.to_lowercase().contains("not a git repository") => fail(
            RunnerErrorCode::NotGitRepo,
            format!("Path is not a git repository: {}", cwd.display()),
        ),
        _ => Err(RunnerError::failed(format!("{command_text} failed: {}", stderr.trim()))),
    }
}

/// Runs git in one directory.
#[derive(Clone)]
pub struct Repo {
    ctx: Ctx,
    pub cwd: PathBuf,
    options: GitOptions,
}

pub fn open_repo(ctx: &Ctx, cwd: impl Into<PathBuf>) -> Repo {
    Repo { ctx: ctx.clone(), cwd: cwd.into(), options: GitOptions::default() }
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

impl Repo {
    async fn text(&self, args: &[&str], allow_failure: bool) -> RunnerResult<GitResult> {
        let output =
            exec_git(&self.ctx, &self.cwd, &owned(args), &self.options, allow_failure).await?;
        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: output.stderr,
            exit_code: output.exit_code,
            truncated: output.truncated,
        })
    }

    /// Runs git and fails on a non-zero exit.
    pub async fn git(&self, args: &[&str]) -> RunnerResult<GitResult> {
        self.text(args, false).await
    }

    /// Runs git and returns a non-zero exit as `exit_code`.
    pub async fn attempt(&self, args: &[&str]) -> RunnerResult<GitResult> {
        self.text(args, true).await
    }

    /// The trimmed stdout, or `None` on failure or empty output.
    pub async fn line(&self, args: &[&str]) -> RunnerResult<Option<String>> {
        let output = self.text(args, true).await?;
        let line = output.stdout.trim();
        Ok((output.exit_code == 0 && !line.is_empty()).then(|| line.to_owned()))
    }

    pub async fn buffer(&self, args: &[&str]) -> RunnerResult<Vec<u8>> {
        Ok(exec_git(&self.ctx, &self.cwd, &owned(args), &self.options, false).await?.stdout)
    }

    /// The same directory with `extra` laid over the current options.
    pub fn with(&self, extra: GitOptions) -> Repo {
        let mut options = self.options.clone();
        options.timeout_ms = extra.timeout_ms.or(options.timeout_ms);
        options.max_bytes = extra.max_bytes.or(options.max_bytes);
        options.allow_truncated = extra.allow_truncated || options.allow_truncated;
        options.env.extend(extra.env);
        Repo { ctx: self.ctx.clone(), cwd: self.cwd.clone(), options }
    }
}

#[cfg(test)]
pub fn test_ctx(data_dir: &Path) -> Ctx {
    let env = crate::env::fixed_env(crate::env::process_env());
    Ctx { data_dir: data_dir.to_owned(), sink: Arc::new(|_| {}), env, lock: KeyedLock::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names() {
        assert!(is_valid_git_branch_name("bb/fix-thing-thr_1"));
        for bad in ["", "HEAD", "-x", "a..b", "a b", "a/", "a.lock", ".a", "a//b", "a@{1", "a:b"] {
            assert!(!is_valid_git_branch_name(bad), "{bad}");
        }
    }

    #[test]
    fn inside_is_lexical() {
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b/c/../d")));
        assert!(is_inside(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_inside(Path::new("/a/b"), Path::new("/a/b/../c")));
        assert!(!is_inside(Path::new("/a/b"), Path::new("/a/bc")));
    }

    #[tokio::test]
    async fn git_reports_not_a_repo_and_runs_in_one() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let repo = open_repo(&ctx, dir.path());
        let error = repo.git(&["status"]).await.unwrap_err();
        assert_eq!(error.code, RunnerErrorCode::NotGitRepo);
        repo.git(&["init", "-q", "-b", "main"]).await.unwrap();
        assert_eq!(
            repo.line(&["symbolic-ref", "--short", "HEAD"]).await.unwrap().as_deref(),
            Some("main")
        );
        assert_eq!(repo.attempt(&["rev-parse", "HEAD"]).await.unwrap().exit_code, 128);
        let missing = open_repo(&ctx, dir.path().join("nope"));
        assert_eq!(missing.git(&["status"]).await.unwrap_err().code, RunnerErrorCode::PathNotFound);
    }

    #[tokio::test]
    async fn keyed_lock_serializes_one_key() {
        let lock = KeyedLock::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        let run = |name: &'static str, wait: u64| {
            let (lock, order) = (lock.clone(), order.clone());
            async move {
                lock.run("k", async {
                    order.lock().push(format!("{name}:start"));
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    order.lock().push(format!("{name}:end"));
                })
                .await
            }
        };
        tokio::join!(run("a", 20), run("b", 1));
        assert_eq!(*order.lock(), ["a:start", "a:end", "b:start", "b:end"]);
        assert!(lock.tails.lock().is_empty());
    }
}
