use serde_json::json;

use crate::context::Ctx;
use crate::db::projects::delete_project;
use crate::domain::changes::ThreadChangeMetadata;
use crate::domain::changes::{EnvironmentChangeKind, ProjectChangeKind, ThreadChangeKind};
use crate::environments::manager::remove_project_workspaces;
use crate::error::ApiResult;
use crate::projects::attachments::project_attachments_dir;
use crate::threads::engine::ops::release_deleted_project;

pub async fn remove_project(ctx: &Ctx, project_id: &str) -> ApiResult<()> {
    let deleted = delete_project(&ctx.db, project_id)?;
    ctx.hub.project(project_id, vec![ProjectChangeKind::ProjectDeleted]);
    for thread_id in &deleted.thread_ids {
        let metadata =
            ThreadChangeMetadata { project_id: Some(project_id.to_owned()), ..Default::default() };
        ctx.hub.thread(thread_id, vec![ThreadChangeKind::ThreadDeleted], Some(metadata));
    }
    for environment in &deleted.environments {
        ctx.hub.environment(&environment.id, vec![EnvironmentChangeKind::EnvironmentDeleted]);
    }
    let attachments = project_attachments_dir(&ctx.config.data_dir, project_id);
    match tokio::fs::remove_dir_all(&attachments).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let ctx = ctx.clone();
    let project_id = project_id.to_owned();
    tokio::spawn(async move {
        remove_project_workspaces(&ctx, &deleted).await;
        if let Err(err) = release_deleted_project(&ctx, &deleted) {
            let fields = json!({ "err": err.to_string(), "projectId": project_id });
            ctx.log.error("Project deletion cleanup failed", fields);
        }
    });
    Ok(())
}
