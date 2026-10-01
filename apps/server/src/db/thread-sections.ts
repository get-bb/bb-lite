import type {
  ThreadSectionMutationResponse,
  ThreadSectionResponse,
} from "@bb/server-contract";
import { newId, type Db } from "./index.js";
import { updateRow } from "./update-row.js";

export type SectionWrite<Result> =
  | { outcome: "ok"; result: Result }
  | { outcome: "duplicate" | "not-found" };

export interface DeletedSection extends ThreadSectionMutationResponse {
  threads: { id: string; projectId: string }[];
}

const SECTION_COLUMNS = "id, name, created_at, updated_at";

function findSection(
  db: Db,
  column: "id" | "name",
  value: string,
): ThreadSectionResponse | undefined {
  return db.get<ThreadSectionResponse>(
    `SELECT ${SECTION_COLUMNS} FROM thread_sections WHERE ${column} = ?`,
    value,
  );
}

export function listThreadSections(db: Db): ThreadSectionResponse[] {
  return db.all<ThreadSectionResponse>(
    `SELECT ${SECTION_COLUMNS} FROM thread_sections ORDER BY name, id`,
  );
}

export function createThreadSection(
  db: Db,
  name: string,
): SectionWrite<ThreadSectionResponse> {
  return db.transaction((): SectionWrite<ThreadSectionResponse> => {
    if (findSection(db, "name", name)) return { outcome: "duplicate" };
    const section = {
      id: newId("sec"),
      name,
      createdAt: db.now(),
      updatedAt: db.now(),
    };
    db.run(
      `INSERT INTO thread_sections (${SECTION_COLUMNS}) VALUES (?, ?, ?, ?)`,
      section.id,
      section.name,
      section.createdAt,
      section.updatedAt,
    );
    return { outcome: "ok", result: section };
  });
}

export function renameThreadSection(
  db: Db,
  id: string,
  name: string,
): SectionWrite<ThreadSectionMutationResponse> {
  return db.transaction((): SectionWrite<ThreadSectionMutationResponse> => {
    if (findSection(db, "id", id) === undefined) {
      return { outcome: "not-found" };
    }
    const sameName = findSection(db, "name", name);
    if (sameName !== undefined && sameName.id !== id) {
      return { outcome: "duplicate" };
    }
    if (sameName === undefined) updateRow(db, "thread_sections", id, { name });
    return { outcome: "ok", result: { id, name, updatedThreadCount: 0 } };
  });
}

export function deleteThreadSection(
  db: Db,
  id: string,
): DeletedSection | undefined {
  return db.transaction(() => {
    const section = findSection(db, "id", id);
    if (section === undefined) return undefined;
    const threads = db.all<{ id: string; projectId: string }>(
      "SELECT id, project_id FROM threads WHERE section_id = ?",
      id,
    );
    db.run(
      "UPDATE threads SET section_id = NULL, updated_at = ? WHERE section_id = ?",
      db.now(),
      id,
    );
    db.run("DELETE FROM thread_sections WHERE id = ?", id);
    const updatedThreadCount = threads.length;
    return { id, name: section.name, updatedThreadCount, threads };
  });
}
