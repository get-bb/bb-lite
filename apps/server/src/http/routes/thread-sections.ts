import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  createThreadSection,
  deleteThreadSection,
  listThreadSections,
  renameThreadSection,
  type SectionWrite,
} from "../../db/thread-sections.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

function sectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw invalidRequest("Section name cannot be empty");
  return trimmed;
}

function sectionNotFound(): ApiError {
  return new ApiError(404, "section_not_found", "Section not found");
}

function written<Result>(write: SectionWrite<Result>): Result {
  if (write.outcome === "ok") return write.result;
  if (write.outcome === "not-found") throw sectionNotFound();
  throw new ApiError(
    409,
    "section_name_conflict",
    "Section name already exists",
  );
}

export function registerThreadSectionRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.threadSections;
  const { db, hub } = ctx;
  const announceSections = (): void =>
    hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);

  get(routes.list, (c) => c.json(listThreadSections(db)));

  post(routes.create, (c, payload) => {
    const section = written(createThreadSection(db, sectionName(payload.name)));
    announceSections();
    return c.json(section, 201);
  });

  patch(routes.update, (c, payload) => {
    const name = sectionName(payload.name);
    const renamed = written(renameThreadSection(db, payload.id, name));
    announceSections();
    return c.json(renamed);
  });

  del(routes.delete, (c, payload) => {
    const deleted = deleteThreadSection(db, payload.id);
    if (deleted === undefined) throw sectionNotFound();
    const { threads, ...result } = deleted;
    for (const { id, projectId } of threads) {
      hub.thread(id, ["title-changed"], { projectId });
    }
    const projectIds = threads.map((thread) => thread.projectId);
    for (const projectId of new Set([PERSONAL_PROJECT_ID, ...projectIds])) {
      hub.project(projectId, ["threads-changed"]);
    }
    return c.json(result);
  });
}
