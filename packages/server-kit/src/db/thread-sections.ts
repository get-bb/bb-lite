import type {
  ThreadSectionMutationResponse,
  ThreadSectionResponse,
} from "@bb/server-contract";
import { viewerId } from "../auth/actor.js";
import { ApiError } from "../http/errors.js";
import { insertRow, newId, updateRow, type Db } from "./index.js";

export interface DeletedSection extends ThreadSectionMutationResponse {
  threads: { id: string; projectId: string }[];
}

const SECTION_COLUMNS = "id, name, created_at, updated_at";

function findSection(db: Db, column: "id" | "name", value: string) {
  return db.get<ThreadSectionResponse>(
    `SELECT ${SECTION_COLUMNS} FROM thread_sections
     WHERE ${column} = ? AND user_id = ?`,
    value,
    viewerId(),
  );
}

export function requireThreadSection(
  db: Db,
  id: string,
): ThreadSectionResponse {
  const section = findSection(db, "id", id);
  if (section !== undefined) return section;
  throw new ApiError(404, "section_not_found", "Section not found");
}

function nameTaken() {
  const message = "Section name already exists";
  return new ApiError(409, "section_name_conflict", message);
}

export function listThreadSections(db: Db): ThreadSectionResponse[] {
  return db.all<ThreadSectionResponse>(
    `SELECT ${SECTION_COLUMNS} FROM thread_sections
     WHERE user_id = ? ORDER BY name, id`,
    viewerId(),
  );
}

export function createThreadSection(
  db: Db,
  name: string,
): ThreadSectionResponse {
  return db.transaction(() => {
    if (findSection(db, "name", name)) throw nameTaken();
    const at = { createdAt: db.now(), updatedAt: db.now() };
    const section = { id: newId("sec"), name, ...at };
    insertRow(db, "thread_sections", { ...section, userId: viewerId() });
    return section;
  });
}

export function renameThreadSection(
  db: Db,
  id: string,
  name: string,
): ThreadSectionMutationResponse {
  return db.transaction(() => {
    requireThreadSection(db, id);
    const sameName = findSection(db, "name", name);
    if (sameName !== undefined && sameName.id !== id) throw nameTaken();
    if (sameName === undefined) updateRow(db, "thread_sections", id, { name });
    return { id, name, updatedThreadCount: 0 };
  });
}

export function deleteThreadSection(db: Db, id: string): DeletedSection {
  return db.transaction(() => {
    const { name } = requireThreadSection(db, id);
    const threads = db.all<{ id: string; projectId: string }>(
      `SELECT threads.id, threads.project_id FROM thread_user_state AS s
       JOIN threads ON threads.id = s.thread_id WHERE s.section_id = ?`,
      id,
    );
    const sql = "UPDATE thread_user_state SET section_id = NULL";
    db.run(`${sql} WHERE section_id = ?`, id);
    db.run("DELETE FROM thread_sections WHERE id = ?", id);
    return { id, name, updatedThreadCount: threads.length, threads };
  });
}
