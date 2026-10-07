use std::fs::Metadata;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bb_core::exec::{Ctx, GitOptions, is_inside, normalize, open_repo, require_safe_ref};
use bb_core::{RunnerError, RunnerErrorCode, RunnerResult, fail};
use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::FILE_PAYLOAD_MAX_BYTES;

const BLOB_CHUNK_SOURCE_MAX_BYTES: usize = 25 * 1024 * 1024;
const FRAME_SAFE: usize = 700 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentEncoding {
    Utf8,
    Base64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileArgs {
    pub path: String,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub git_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileChunkArgs {
    pub path: String,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub git_ref: Option<String>,
    pub offset: f64,
    pub length: f64,
    #[serde(default)]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub content_encoding: ContentEncoding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub modified_at_ms: Option<f64>,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub path: String,
    pub mime_type: Option<String>,
    pub offset: u64,
    pub size_bytes: u64,
    #[serde(serialize_with = "js_number")]
    pub modified_at_ms: Option<f64>,
    pub revision: String,
    pub data_base64: String,
}

/// Where a path resolved to, and the real root it was confined to.
#[derive(Clone, Debug)]
pub struct Confined {
    pub target: PathBuf,
    pub root: Option<PathBuf>,
}

struct Blob {
    oid: String,
    contents: Vec<u8>,
}

/// Serializes an integral float without a fraction, as `JSON.stringify` does.
pub fn js_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        None => serializer.serialize_none(),
        Some(number) if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER => {
            serializer.serialize_i64(*number as i64)
        }
        Some(number) => serializer.serialize_f64(*number),
    }
}

pub fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(data.as_ref()))
}

pub fn absolute_target(target: &str, root_path: Option<&str>) -> RunnerResult<PathBuf> {
    if target.contains('\0') || root_path.is_some_and(|root| root.contains('\0')) {
        return fail(RunnerErrorCode::InvalidPath, "Path must not contain NUL");
    }
    if root_path.is_some_and(|root| !Path::new(root).is_absolute()) {
        return fail(RunnerErrorCode::InvalidPath, "rootPath must be absolute");
    }
    if root_path.is_none() && !Path::new(target).is_absolute() {
        return fail(RunnerErrorCode::InvalidPath, "A relative path needs rootPath");
    }
    Ok(normalize(&Path::new(root_path.unwrap_or("/")).join(target)))
}

pub async fn resolve_root(root_path: Option<&str>) -> RunnerResult<Option<PathBuf>> {
    let Some(root) = root_path else { return Ok(None) };
    let stat = tokio::fs::symlink_metadata(root).await?;
    if stat.file_type().is_symlink() || !stat.is_dir() {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Root \"{root}\" must be a real directory"),
        );
    }
    Ok(Some(tokio::fs::canonicalize(root).await?))
}

pub fn require_inside_root(
    real_root: Option<&Path>,
    real_target: &Path,
    label: &str,
) -> RunnerResult<()> {
    match real_root {
        Some(root) if !is_inside(root, real_target) => {
            fail(RunnerErrorCode::InvalidPath, format!("Path \"{label}\" escapes its root"))
        }
        _ => Ok(()),
    }
}

pub async fn confined_target(path: &str, root_path: Option<&str>) -> RunnerResult<Confined> {
    let absolute = absolute_target(path, root_path)?;
    let root = resolve_root(root_path).await?;
    let target = tokio::fs::canonicalize(&absolute).await?;
    require_inside_root(root.as_deref(), &target, path)?;
    Ok(Confined { target, root })
}

/// The `mime-types` lookup: the extension of `x.<target>`, so a bare `json` is JSON too.
pub fn mime_type_of(target: &str) -> Option<String> {
    let joined = format!("x.{target}");
    let base = joined.rsplit('/').next().unwrap_or_default();
    let dot = base.rfind('.').filter(|index| *index > 0)?;
    let extension = &base[dot + 1..];
    if extension.is_empty() {
        return None;
    }
    mime_guess::from_ext(extension).first_raw().map(str::to_owned)
}

fn json_string_length(text: &str) -> usize {
    2 + text
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if c < ' ' => 6,
            c => c.len_utf16(),
        })
        .sum::<usize>()
}

async fn read_blob(
    ctx: &Ctx,
    path: &str,
    root_path: Option<&str>,
    git_ref: &str,
    max_bytes: usize,
) -> RunnerResult<Option<Blob>> {
    let Some(root) = root_path else {
        return fail(RunnerErrorCode::InvalidPath, "rootPath is required with gitRef");
    };
    let absolute = absolute_target(path, Some(root))?;
    let relative = absolute.strip_prefix(normalize(Path::new(root))).ok();
    let relative = match relative {
        Some(relative) if !relative.as_os_str().is_empty() => relative.to_string_lossy(),
        _ => {
            return fail(RunnerErrorCode::InvalidPath, format!("Path \"{path}\" escapes its root"));
        }
    };
    let repo = open_repo(ctx, root);
    let spec = format!("{}:./{relative}", require_safe_ref(git_ref)?);
    let Some(oid) = repo.line(&["rev-parse", "--verify", "--quiet", &spec]).await? else {
        return Ok(None);
    };
    let size = repo.git(&["cat-file", "-s", &oid]).await?.stdout.trim().parse().unwrap_or(0);
    if size > max_bytes {
        return fail(RunnerErrorCode::FileTooLarge, format!("{path} at {git_ref} is {size} bytes"));
    }
    let sized = repo.with(GitOptions { max_bytes: Some(size.max(1)), ..GitOptions::default() });
    let contents = sized.buffer(&["cat-file", "blob", &oid]).await?;
    Ok(Some(Blob { oid, contents }))
}

fn describe(path: &str, contents: &[u8], modified_at_ms: Option<f64>) -> FileContent {
    let mime_type = mime_type_of(path);
    let image = mime_type
        .as_deref()
        .is_some_and(|mime| mime.starts_with("image/") && mime != "image/svg+xml");
    let text = if image { None } else { std::str::from_utf8(contents).ok() };
    let text = text.filter(|text| json_string_length(text) < FRAME_SAFE);
    let (content, content_encoding) = match text {
        Some(text) => (text.to_owned(), ContentEncoding::Utf8),
        None => (STANDARD.encode(contents), ContentEncoding::Base64),
    };
    FileContent {
        path: path.to_owned(),
        content,
        content_encoding,
        mime_type,
        modified_at_ms,
        sha256: sha256_hex(contents),
        size_bytes: contents.len() as u64,
    }
}

fn mtime_ms(stat: &Metadata) -> f64 {
    stat.mtime() as f64 * 1e3 + stat.mtime_nsec() as f64 / 1e6
}

pub async fn read_file(ctx: &Ctx, args: ReadFileArgs) -> RunnerResult<FileContent> {
    let root = args.root_path.as_deref();
    if let Some(git_ref) = &args.git_ref {
        let blob = read_blob(ctx, &args.path, root, git_ref, FILE_PAYLOAD_MAX_BYTES).await?;
        let contents = blob.map(|blob| blob.contents).unwrap_or_default();
        return Ok(describe(&args.path, &contents, None));
    }
    let readable = confined_target(&args.path, root).await?.target;
    let stat = tokio::fs::metadata(&readable).await?;
    if !stat.is_file() {
        return fail(RunnerErrorCode::InvalidPath, "Path is not a regular file");
    }
    let contents = if stat.len() > FILE_PAYLOAD_MAX_BYTES as u64 {
        None
    } else {
        Some(tokio::fs::read(&readable).await?)
    };
    match contents {
        Some(contents) if contents.len() <= FILE_PAYLOAD_MAX_BYTES => {
            Ok(describe(&args.path, &contents, Some(mtime_ms(&stat))))
        }
        _ => {
            let hint = format!("read it in chunks of {FILE_PAYLOAD_MAX_BYTES} bytes");
            fail(RunnerErrorCode::FileTooLarge, format!("{} is too large; {hint}", args.path))
        }
    }
}

fn nanos(seconds: i64, nanoseconds: i64) -> i128 {
    i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds)
}

fn file_revision(stat: &Metadata) -> String {
    let mtime_ns = nanos(stat.mtime(), stat.mtime_nsec());
    let ctime_ns = nanos(stat.ctime(), stat.ctime_nsec());
    sha256_hex(format!("{}:{}:{}:{mtime_ns}:{ctime_ns}", stat.dev(), stat.ino(), stat.size()))
}

fn require_unchanged(expected: Option<&str>, revision: &str) -> RunnerResult<()> {
    match expected {
        Some(expected) if expected != revision => {
            Err(RunnerError::retryable(RunnerErrorCode::Conflict, "File changed during read"))
        }
        _ => Ok(()),
    }
}

fn is_natural(value: f64) -> bool {
    value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&value)
}

pub async fn read_file_chunk(ctx: &Ctx, args: ReadFileChunkArgs) -> RunnerResult<FileChunk> {
    let valid = is_natural(args.offset) && is_natural(args.length);
    if !valid || args.length > FILE_PAYLOAD_MAX_BYTES as f64 {
        return fail(
            RunnerErrorCode::Failed,
            format!("A chunk is at most {FILE_PAYLOAD_MAX_BYTES} bytes"),
        );
    }
    let offset = args.offset as u64;
    let length = args.length as u64;
    let mime_type = mime_type_of(&args.path);
    let root = args.root_path.as_deref();
    let expected = args.revision.as_deref();
    if let Some(git_ref) = &args.git_ref {
        let blob = read_blob(ctx, &args.path, root, git_ref, BLOB_CHUNK_SOURCE_MAX_BYTES).await?;
        let oid = blob.as_ref().map(|blob| blob.oid.as_str()).unwrap_or_default();
        let revision = sha256_hex(format!("blob:{oid}"));
        require_unchanged(expected, &revision)?;
        let contents = blob.as_ref().map(|blob| blob.contents.as_slice()).unwrap_or_default();
        let size = contents.len() as u64;
        let bytes =
            &contents[offset.min(size) as usize..offset.saturating_add(length).min(size) as usize];
        return Ok(FileChunk {
            path: args.path,
            mime_type,
            offset,
            size_bytes: size,
            modified_at_ms: None,
            revision,
            data_base64: STANDARD.encode(bytes),
        });
    }
    let target = confined_target(&args.path, root).await?.target;
    let expected = args.revision.clone();
    let read = tokio::task::spawn_blocking(move || -> RunnerResult<(Metadata, String, Vec<u8>)> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&target)?;
        let stat = file.metadata()?;
        if !stat.is_file() || stat.size() as f64 > MAX_SAFE_INTEGER {
            return fail(RunnerErrorCode::InvalidPath, "Path is not a readable file");
        }
        let revision = file_revision(&stat);
        require_unchanged(expected.as_deref(), &revision)?;
        let wanted = length.min(stat.size().saturating_sub(offset)) as usize;
        let mut bytes = vec![0u8; wanted];
        let mut filled = 0;
        while filled < wanted {
            let read = file.read_at(&mut bytes[filled..], offset + filled as u64)?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        let after = file_revision(&file.metadata()?);
        require_unchanged(Some(&revision), if filled == wanted { &after } else { "" })?;
        Ok((stat, revision, bytes))
    })
    .await
    .map_err(|error| RunnerError::failed(error.to_string()))?;
    let (stat, revision, bytes) = read?;
    Ok(FileChunk {
        path: args.path,
        mime_type,
        offset,
        size_bytes: stat.size(),
        modified_at_ms: Some(nanos(stat.mtime(), stat.mtime_nsec()) as f64 / 1_000_000.0),
        revision,
        data_base64: STANDARD.encode(bytes),
    })
}
