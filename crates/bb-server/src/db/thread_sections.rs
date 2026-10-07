#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};

use super::{Db, DbResult, OnConflict, insert_row, new_id, params, update_row};
use crate::error::{ApiError, ApiResult};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionResponse {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionMutationResponse {
    pub id: String,
    pub name: String,
    pub updated_thread_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionThread {
    pub id: String,
    pub project_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedSection {
    pub id: String,
    pub name: String,
    pub updated_thread_count: i64,
    pub threads: Vec<SectionThread>,
}

impl DeletedSection {
    pub fn response(&self) -> ThreadSectionMutationResponse {
        ThreadSectionMutationResponse {
            id: self.id.clone(),
            name: self.name.clone(),
            updated_thread_count: self.updated_thread_count,
        }
    }
}

const SECTION_COLUMNS: &str = "id, name, created_at, updated_at";

fn find_section(db: &Db, column: &str, value: &str) -> DbResult<Option<ThreadSectionResponse>> {
    db.get(&format!("SELECT {SECTION_COLUMNS} FROM thread_sections WHERE {column} = ?"), [value])
}

pub fn require_thread_section(db: &Db, id: &str) -> ApiResult<ThreadSectionResponse> {
    find_section(db, "id", id)?
        .ok_or_else(|| ApiError::new(404, "section_not_found", "Section not found"))
}

fn name_taken() -> ApiError {
    let message = "Section name already exists";
    ApiError::new(409, "section_name_conflict", message)
}

pub fn list_thread_sections(db: &Db) -> DbResult<Vec<ThreadSectionResponse>> {
    db.all(&format!("SELECT {SECTION_COLUMNS} FROM thread_sections ORDER BY name, id"), [])
}

pub fn create_thread_section(db: &Db, name: &str) -> ApiResult<ThreadSectionResponse> {
    db.transaction(|| {
        if find_section(db, "name", name)?.is_some() {
            return Err(name_taken());
        }
        let section = ThreadSectionResponse {
            id: new_id("sec"),
            name: name.to_owned(),
            created_at: db.now(),
            updated_at: db.now(),
        };
        let row = crate::row! {
            "id" => &section.id,
            "name" => &section.name,
            "createdAt" => section.created_at,
            "updatedAt" => section.updated_at,
        };
        insert_row(db, "thread_sections", &row, OnConflict::Fail)?;
        Ok(section)
    })
}

pub fn rename_thread_section(
    db: &Db,
    id: &str,
    name: &str,
) -> ApiResult<ThreadSectionMutationResponse> {
    db.transaction(|| {
        require_thread_section(db, id)?;
        let same_name = find_section(db, "name", name)?;
        if same_name.as_ref().is_some_and(|section| section.id != id) {
            return Err(name_taken());
        }
        if same_name.is_none() {
            update_row(db, "thread_sections", id, &crate::row! { "name" => name }, true)?;
        }
        Ok(ThreadSectionMutationResponse {
            id: id.to_owned(),
            name: name.to_owned(),
            updated_thread_count: 0,
        })
    })
}

pub fn delete_thread_section(db: &Db, id: &str) -> ApiResult<DeletedSection> {
    db.transaction(|| {
        let ThreadSectionResponse { name, .. } = require_thread_section(db, id)?;
        let threads: Vec<SectionThread> =
            db.all("SELECT id, project_id FROM threads WHERE section_id = ?", [id])?;
        db.run(
            "UPDATE threads SET section_id = NULL, updated_at = ? WHERE section_id = ?",
            params![db.now(), id],
        )?;
        db.run("DELETE FROM thread_sections WHERE id = ?", [id])?;
        Ok(DeletedSection {
            id: id.to_owned(),
            name,
            updated_thread_count: threads.len() as i64,
            threads,
        })
    })
}
