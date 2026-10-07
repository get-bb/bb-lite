use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use bb_core::exec::Ctx;
use bb_core::ids::random_hex;
use bb_core::{RunnerErrorCode, RunnerResult, fail};
use serde::{Deserialize, Deserializer, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::FILE_PAYLOAD_MAX_BYTES;
use crate::read::{
    Confined, ContentEncoding, absolute_target, confined_target, require_inside_root, resolve_root,
    sha256_hex,
};

const DEFAULT_FILE_MODE: u32 = 0o666;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileArgs {
    pub path: String,
    #[serde(default)]
    pub root_path: Option<String>,
    pub content: String,
    #[serde(default)]
    pub content_encoding: Option<ContentEncoding>,
    #[serde(default)]
    pub create_parents: Option<bool>,
    /// Absent writes unconditionally; `Some(None)` requires that the file does not exist.
    #[serde(default, deserialize_with = "present")]
    pub expected_sha256: Option<Option<String>>,
    #[serde(default)]
    pub mode: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileChunkArgs {
    pub path: String,
    #[serde(default)]
    pub root_path: Option<String>,
    pub offset: f64,
    pub data_base64: String,
    #[serde(default)]
    pub create_parents: Option<bool>,
    #[serde(default)]
    pub mode: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum FileWriteResult {
    #[serde(rename = "written", rename_all = "camelCase")]
    Written { sha256: String, size_bytes: u64 },
    #[serde(rename = "conflict", rename_all = "camelCase")]
    Conflict { current_sha256: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileChunkResult {
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum MutatePathArgs {
    #[serde(rename_all = "camelCase")]
    Mkdir {
        path: String,
        #[serde(default)]
        root_path: Option<String>,
        #[serde(default)]
        recursive: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Remove {
        path: String,
        #[serde(default)]
        root_path: Option<String>,
        #[serde(default)]
        recursive: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Move {
        source_path: String,
        destination_path: String,
        #[serde(default)]
        root_path: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MutatePathResult {
    pub ok: bool,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

struct WriteTarget {
    write_path: PathBuf,
    parent_missing: bool,
}

async fn resolve_write_target(target: &Path) -> RunnerResult<WriteTarget> {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut ancestor = target.to_path_buf();
    loop {
        match tokio::fs::canonicalize(&ancestor).await {
            Ok(real) => {
                let write_path = missing.iter().rev().fold(real, |path, part| path.join(part));
                return Ok(WriteTarget { write_path, parent_missing: missing.len() > 1 });
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let (Some(parent), Some(name)) = (ancestor.parent(), ancestor.file_name()) else {
            let shown = target.display();
            return fail(RunnerErrorCode::PathNotFound, format!("Path does not exist: {shown}"));
        };
        missing.push(name.to_owned());
        ancestor = parent.to_path_buf();
    }
}

async fn confined_write_path(path: &str, root_path: Option<&str>) -> RunnerResult<WriteTarget> {
    let absolute = absolute_target(path, root_path)?;
    let target = resolve_write_target(&absolute).await?;
    let real_root = resolve_root(root_path).await?;
    require_inside_root(real_root.as_deref(), &target.write_path, path)?;
    let existing = tokio::fs::symlink_metadata(&target.write_path).await.ok();
    if existing.is_some_and(|stat| stat.file_type().is_symlink()) {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Path \"{path}\" is a dangling symlink"),
        );
    }
    Ok(target)
}

async fn writable_file(
    path: &str,
    root_path: Option<&str>,
    create_parents: Option<bool>,
) -> RunnerResult<PathBuf> {
    let WriteTarget { write_path, parent_missing } = confined_write_path(path, root_path).await?;
    let parent = write_path.parent().unwrap_or(Path::new("/"));
    if create_parents == Some(true) {
        tokio::fs::create_dir_all(parent).await?;
    } else if parent_missing {
        let shown = parent.display();
        return fail(RunnerErrorCode::PathNotFound, format!("Path does not exist: {shown}"));
    }
    Ok(write_path)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decodes base64 as leniently as Node's `Buffer.from(text, "base64")`.
pub fn decode_base64_lenient(text: &str) -> Vec<u8> {
    let digits: Vec<u8> =
        text.bytes().take_while(|byte| *byte != b'=').filter_map(base64_value).collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for group in digits.chunks(4) {
        let value = group
            .iter()
            .enumerate()
            .fold(0u32, |value, (index, digit)| value | (u32::from(*digit) << (18 - 6 * index)));
        let bytes = value.to_be_bytes();
        out.extend_from_slice(&bytes[1..group.len().max(1)]);
    }
    out
}

fn decode_payload(content: &str, encoding: ContentEncoding) -> RunnerResult<Vec<u8>> {
    let contents = match encoding {
        ContentEncoding::Utf8 => content.as_bytes().to_vec(),
        ContentEncoding::Base64 => decode_base64_lenient(content),
    };
    if contents.len() > FILE_PAYLOAD_MAX_BYTES {
        let limit = format!("{FILE_PAYLOAD_MAX_BYTES} bytes");
        return fail(
            RunnerErrorCode::FileTooLarge,
            format!("A write carries at most {limit}; send chunks"),
        );
    }
    Ok(contents)
}

async fn current_sha256(target: &Path) -> RunnerResult<Option<String>> {
    match tokio::fs::read(target).await {
        Ok(contents) => Ok(Some(sha256_hex(contents))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn write_temporary(path: &Path, contents: &[u8], mode: Option<u32>) -> RunnerResult<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode.unwrap_or(DEFAULT_FILE_MODE))
        .open(path)
        .await?;
    file.write_all(contents).await?;
    if let Some(mode) = mode {
        file.set_permissions(std::fs::Permissions::from_mode(mode)).await?;
    }
    file.sync_all().await?;
    Ok(())
}

async fn replace_if_unchanged(
    target: &Path,
    contents: &[u8],
    mode: Option<u32>,
    expected_sha256: Option<&str>,
) -> RunnerResult<Option<FileWriteResult>> {
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(format!(".bb-write-{}", random_hex(16)));
    let temporary = PathBuf::from(temporary);
    let attempt = async {
        write_temporary(&temporary, contents, mode).await?;
        let replaced = match expected_sha256 {
            None => match tokio::fs::hard_link(&temporary, target).await {
                Ok(()) => true,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
                Err(error) => return Err(error.into()),
            },
            Some(expected) => {
                let unchanged = current_sha256(target).await?.as_deref() == Some(expected);
                if unchanged {
                    tokio::fs::rename(&temporary, target).await?;
                }
                unchanged
            }
        };
        if replaced {
            return Ok(None);
        }
        let current_sha256 = current_sha256(target).await?;
        Ok(Some(FileWriteResult::Conflict { current_sha256 }))
    };
    let result = attempt.await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}

pub async fn write_file(ctx: &Ctx, args: WriteFileArgs) -> RunnerResult<FileWriteResult> {
    let encoding = args.content_encoding.unwrap_or(ContentEncoding::Utf8);
    let contents = decode_payload(&args.content, encoding)?;
    let root = args.root_path.as_deref();
    let target = writable_file(&args.path, root, args.create_parents).await?;
    let key = format!("file:{}", target.display());
    ctx.lock
        .run(&key, async {
            let stat = tokio::fs::metadata(&target).await.ok();
            if stat.as_ref().is_some_and(|stat| stat.is_dir()) {
                return fail(RunnerErrorCode::InvalidPath, "Path is a directory, not a file");
            }
            let mode = args.mode.or(stat.map(|stat| stat.permissions().mode() & 0o777));
            match &args.expected_sha256 {
                None => {
                    let mut file = tokio::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(mode.unwrap_or(DEFAULT_FILE_MODE))
                        .open(&target)
                        .await?;
                    file.write_all(&contents).await?;
                    file.flush().await?;
                }
                Some(expected) => {
                    let existing = current_sha256(&target).await?;
                    let conflict = if existing == *expected {
                        replace_if_unchanged(&target, &contents, mode, existing.as_deref()).await?
                    } else {
                        Some(FileWriteResult::Conflict { current_sha256: existing })
                    };
                    if let Some(conflict) = conflict {
                        return Ok(conflict);
                    }
                }
            }
            let size_bytes = contents.len() as u64;
            Ok(FileWriteResult::Written { sha256: sha256_hex(&contents), size_bytes })
        })
        .await
}

pub async fn write_file_chunk(
    ctx: &Ctx,
    args: WriteFileChunkArgs,
) -> RunnerResult<WriteFileChunkResult> {
    let contents = decode_payload(&args.data_base64, ContentEncoding::Base64)?;
    let offset = args.offset;
    if offset.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
        return fail(RunnerErrorCode::Failed, "offset must be a non-negative integer");
    }
    let offset = offset as u64;
    let root = args.root_path.as_deref();
    let target = writable_file(&args.path, root, args.create_parents).await?;
    let key = format!("file:{}", target.display());
    ctx.lock
        .run(&key, async {
            let mut options = tokio::fs::OpenOptions::new();
            if offset == 0 {
                options.write(true).create(true).truncate(true);
            } else {
                options.read(true).write(true);
            }
            let mut file =
                options.mode(args.mode.unwrap_or(DEFAULT_FILE_MODE)).open(&target).await?;
            let size = file.metadata().await?.len();
            if offset > size {
                let message = format!("Chunk offset {offset} is past the end ({size})");
                return fail(RunnerErrorCode::Conflict, message);
            }
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            file.write_all(&contents).await?;
            file.flush().await?;
            Ok(WriteFileChunkResult { size_bytes: size.max(offset + contents.len() as u64) })
        })
        .await
}

async fn existing_target(path: &str, root_path: Option<&str>) -> RunnerResult<Confined> {
    let absolute = absolute_target(path, root_path)?;
    if tokio::fs::symlink_metadata(&absolute).await?.file_type().is_symlink() {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Path \"{path}\" must not be a symlink"),
        );
    }
    confined_target(path, root_path).await
}

pub async fn mutate_path(_ctx: &Ctx, args: MutatePathArgs) -> RunnerResult<MutatePathResult> {
    match args {
        MutatePathArgs::Mkdir { path, root_path, recursive } => {
            let target = confined_write_path(&path, root_path.as_deref()).await?;
            if recursive == Some(true) {
                tokio::fs::create_dir_all(&target.write_path).await?;
            } else {
                tokio::fs::create_dir(&target.write_path).await?;
            }
        }
        MutatePathArgs::Move { source_path, destination_path, root_path } => {
            let root = root_path.as_deref();
            let source = existing_target(&source_path, root).await?;
            let absolute = absolute_target(&destination_path, root)?;
            let parent = absolute.parent().unwrap_or(Path::new("/"));
            let parent = tokio::fs::canonicalize(parent).await?;
            let destination = match absolute.file_name() {
                Some(name) => parent.join(name),
                None => parent,
            };
            require_inside_root(source.root.as_deref(), &destination, &destination_path)?;
            if tokio::fs::symlink_metadata(&destination).await.is_ok() {
                let message = format!("Destination already exists: {destination_path}");
                return fail(RunnerErrorCode::Conflict, message);
            }
            tokio::fs::rename(&source.target, &destination).await?;
        }
        MutatePathArgs::Remove { path, root_path, recursive } => {
            let Confined { target, root } = existing_target(&path, root_path.as_deref()).await?;
            if root.as_deref() == Some(target.as_path()) {
                return fail(RunnerErrorCode::InvalidPath, "Cannot remove the declared root");
            }
            let recursive = recursive == Some(true);
            let is_dir = tokio::fs::symlink_metadata(&target).await?.is_dir();
            if is_dir && !recursive {
                tokio::fs::remove_dir(&target).await?;
            } else if is_dir {
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_file(&target).await?;
            }
        }
    }
    Ok(MutatePathResult { ok: true })
}
