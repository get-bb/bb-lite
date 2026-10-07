use std::path::PathBuf;

/// The CLI package root (`apps/cli`), which the server hands to local sessions.
pub fn cli_dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/cli"))
}

pub fn bb_cli_path() -> PathBuf {
    cli_dir().join("bin/bb")
}

pub fn builtin_skills_dir() -> PathBuf {
    cli_dir().join("skills")
}

pub fn guide_dir() -> PathBuf {
    cli_dir().join("guide")
}
