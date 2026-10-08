import {
  sidebarBootstrapResponseSchema,
  type SidebarBootstrapResponse,
} from "@bb/server-contract";
import { createLastKnownCache } from "./last-known-cache";

type SidebarProject = SidebarBootstrapResponse["personalProject"];

const MAX_THREADS_PER_PROJECT = 30;
const cache = createLastKnownCache({
  prefix: "bb.sidebar-bootstrap",
  version: "1",
  schema: sidebarBootstrapResponseSchema,
});
let replay: SidebarBootstrapResponse | null | undefined;
let writeScheduled = false;

function bounded(project: SidebarProject): SidebarProject {
  const threads = project.threads.slice(0, MAX_THREADS_PER_PROJECT);
  return { ...project, threads };
}

export function readCachedSidebarBootstrap(): SidebarBootstrapResponse | null {
  replay ??= cache.read(cache.key());
  return replay;
}

export function writeCachedSidebarBootstrap(
  response: SidebarBootstrapResponse,
): void {
  replay = {
    sections: response.sections,
    projects: response.projects.map(bounded),
    personalProject: bounded(response.personalProject),
  };
  if (writeScheduled) return;
  writeScheduled = true;
  setTimeout(() => {
    writeScheduled = false;
    if (replay) cache.write(cache.key(), replay);
  }, 1_000);
}
