import type { Project } from "@bb/domain";
import type { Db } from "../db/index.js";
import { getProject } from "../db/projects.js";
import { ApiError } from "../http/errors.js";

function projectNotFound(): ApiError {
  return new ApiError(404, "project_not_found", "Project not found");
}

export function requireProject(db: Db, projectId: string): Project {
  const project = getProject(db, projectId);
  if (project === undefined) throw projectNotFound();
  return project;
}

export function requireStandardProject(db: Db, projectId: string): Project {
  const project = requireProject(db, projectId);
  if (project.kind !== "standard") throw projectNotFound();
  return project;
}
