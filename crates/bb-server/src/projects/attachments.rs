use std::path::{Path, PathBuf};

use crate::error::ApiResult;

pub fn resolve_attachment_path(
    _data_dir: &Path,
    _project_id: &str,
    _stored_name: &str,
) -> ApiResult<PathBuf> {
    todo!("projects/attachments port")
}
