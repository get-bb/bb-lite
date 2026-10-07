import {
  createEnvironmentsArea,
  type EnvironmentsArea,
} from "./areas/environments.js";
import { createFilesArea, type FilesArea } from "./areas/files.js";
import { createHostsArea, type HostsArea } from "./areas/hosts.js";
import { createPluginsArea, type PluginsArea } from "./areas/plugins.js";
import { createProjectsArea, type ProjectsArea } from "./areas/projects.js";
import { createProvidersArea, type ProvidersArea } from "./areas/providers.js";
import { createSystemArea, type SystemArea } from "./areas/system.js";
import { createTerminalsArea, type TerminalsArea } from "./areas/terminals.js";
import { createThemeArea, type ThemeArea } from "./areas/theme.js";
import {
  createThreadSectionsArea,
  type ThreadSectionsArea,
} from "./areas/thread-sections.js";
import { createThreadsArea, type ThreadsArea } from "./areas/threads.js";
import {
  createAuthArea,
  createUsersArea,
  type AuthArea,
  type UsersArea,
} from "./areas/users.js";
import { createHttp, type CreateHttpArgs } from "./http.js";

export { BbHttpError, BbRequestTimeoutError } from "./http.js";
export type { BbHttpErrorArgs, FetchImplementation } from "./http.js";
export type * from "./public-types.js";

export interface BbSdkAreas {
  auth: AuthArea;
  users: UsersArea;
  environments: EnvironmentsArea;
  files: FilesArea;
  hosts: HostsArea;
  projects: ProjectsArea;
  plugins: PluginsArea;
  providers: ProvidersArea;
  system: SystemArea;
  terminals: TerminalsArea;
  theme: ThemeArea;
  threadSections: ThreadSectionsArea;
  threads: ThreadsArea;
}

export type BbSdk = BbSdkAreas;

export function createBbSdk(args: CreateHttpArgs): BbSdk {
  const http = createHttp(args);
  return {
    auth: createAuthArea(http),
    users: createUsersArea(http),
    environments: createEnvironmentsArea(http),
    files: createFilesArea(http),
    hosts: createHostsArea(http),
    projects: createProjectsArea(http),
    plugins: createPluginsArea(http),
    providers: createProvidersArea(http),
    system: createSystemArea(http),
    terminals: createTerminalsArea(http),
    theme: createThemeArea(http),
    threadSections: createThreadSectionsArea(http),
    threads: createThreadsArea(http),
  };
}
