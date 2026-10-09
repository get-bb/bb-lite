import * as plugin from "@bb/plugin";
import * as runner from "@bb/runner";
import * as authActor from "@bb/server-kit/auth/actor";
import * as authPasswords from "@bb/server-kit/auth/passwords";
import * as config from "@bb/server-kit/config";
import * as context from "@bb/server-kit/context";
import * as dbAudit from "@bb/server-kit/db/audit";
import * as dbEnvironments from "@bb/server-kit/db/environments";
import * as dbEventRead from "@bb/server-kit/db/event-read";
import * as dbEvents from "@bb/server-kit/db/events";
import * as dbHosts from "@bb/server-kit/db/hosts";
import * as dbIndex from "@bb/server-kit/db/index";
import * as dbOrderKeys from "@bb/server-kit/db/order-keys";
import * as dbPendingInteractions from "@bb/server-kit/db/pending-interactions";
import * as dbPlugins from "@bb/server-kit/db/plugins";
import * as dbProjects from "@bb/server-kit/db/projects";
import * as dbQueuedMessages from "@bb/server-kit/db/queued-messages";
import * as dbSettings from "@bb/server-kit/db/settings";
import * as dbTerminals from "@bb/server-kit/db/terminals";
import * as dbThreadRead from "@bb/server-kit/db/thread-read";
import * as dbThreadSearch from "@bb/server-kit/db/thread-search";
import * as dbThreadSections from "@bb/server-kit/db/thread-sections";
import * as dbThreadUserState from "@bb/server-kit/db/thread-user-state";
import * as dbThreads from "@bb/server-kit/db/threads";
import * as dbUsers from "@bb/server-kit/db/users";
import * as doors from "@bb/server-kit/doors";
import * as environmentsKinds from "@bb/server-kit/environments/kinds";
import * as environmentsTypes from "@bb/server-kit/environments/types";
import * as environmentsWorkspace from "@bb/server-kit/environments/workspace";
import * as httpApi from "@bb/server-kit/http/api";
import * as httpErrors from "@bb/server-kit/http/errors";
import * as httpFileBytes from "@bb/server-kit/http/file-bytes";
import * as httpRange from "@bb/server-kit/http/range";
import * as httpTrust from "@bb/server-kit/http/trust";
import * as kernelCaller from "@bb/server-kit/kernel/caller";
import * as machineEnvironment from "@bb/server-kit/machine-environment";
import * as projectsAttachments from "@bb/server-kit/projects/attachments";
import * as projectsWorkspace from "@bb/server-kit/projects/workspace";
import * as providersCatalog from "@bb/server-kit/providers/catalog";
import * as providersInference from "@bb/server-kit/providers/inference";
import * as providersModels from "@bb/server-kit/providers/models";
import * as providersSettings from "@bb/server-kit/providers/settings";
import * as runnersAccess from "@bb/server-kit/runners/access";
import * as runnersEnrollment from "@bb/server-kit/runners/enrollment";
import * as runnersHosts from "@bb/server-kit/runners/hosts";
import * as runnersLocal from "@bb/server-kit/runners/local";
import * as runnersRegistry from "@bb/server-kit/runners/registry";
import * as services from "@bb/server-kit/services";
import * as threadsSerial from "@bb/server-kit/threads/serial";
import * as threadsThreadDisplay from "@bb/server-kit/threads/thread-display";
import * as wsHub from "@bb/server-kit/ws/hub";

export const SERVER_RUNTIME_GLOBAL = "__bbServerRuntime";

export const SERVER_RUNTIME_MODULES: Record<string, object> = {
  "@bb/plugin": plugin,
  "@bb/runner": runner,
  "@bb/server-kit/auth/actor": authActor,
  "@bb/server-kit/auth/passwords": authPasswords,
  "@bb/server-kit/config": config,
  "@bb/server-kit/context": context,
  "@bb/server-kit/db/audit": dbAudit,
  "@bb/server-kit/db/environments": dbEnvironments,
  "@bb/server-kit/db/event-read": dbEventRead,
  "@bb/server-kit/db/events": dbEvents,
  "@bb/server-kit/db/hosts": dbHosts,
  "@bb/server-kit/db/index": dbIndex,
  "@bb/server-kit/db/order-keys": dbOrderKeys,
  "@bb/server-kit/db/pending-interactions": dbPendingInteractions,
  "@bb/server-kit/db/plugins": dbPlugins,
  "@bb/server-kit/db/projects": dbProjects,
  "@bb/server-kit/db/queued-messages": dbQueuedMessages,
  "@bb/server-kit/db/settings": dbSettings,
  "@bb/server-kit/db/terminals": dbTerminals,
  "@bb/server-kit/db/thread-read": dbThreadRead,
  "@bb/server-kit/db/thread-search": dbThreadSearch,
  "@bb/server-kit/db/thread-sections": dbThreadSections,
  "@bb/server-kit/db/thread-user-state": dbThreadUserState,
  "@bb/server-kit/db/threads": dbThreads,
  "@bb/server-kit/db/users": dbUsers,
  "@bb/server-kit/doors": doors,
  "@bb/server-kit/environments/kinds": environmentsKinds,
  "@bb/server-kit/environments/types": environmentsTypes,
  "@bb/server-kit/environments/workspace": environmentsWorkspace,
  "@bb/server-kit/http/api": httpApi,
  "@bb/server-kit/http/errors": httpErrors,
  "@bb/server-kit/http/file-bytes": httpFileBytes,
  "@bb/server-kit/http/range": httpRange,
  "@bb/server-kit/http/trust": httpTrust,
  "@bb/server-kit/kernel/caller": kernelCaller,
  "@bb/server-kit/machine-environment": machineEnvironment,
  "@bb/server-kit/projects/attachments": projectsAttachments,
  "@bb/server-kit/projects/workspace": projectsWorkspace,
  "@bb/server-kit/providers/catalog": providersCatalog,
  "@bb/server-kit/providers/inference": providersInference,
  "@bb/server-kit/providers/models": providersModels,
  "@bb/server-kit/providers/settings": providersSettings,
  "@bb/server-kit/runners/access": runnersAccess,
  "@bb/server-kit/runners/enrollment": runnersEnrollment,
  "@bb/server-kit/runners/hosts": runnersHosts,
  "@bb/server-kit/runners/local": runnersLocal,
  "@bb/server-kit/runners/registry": runnersRegistry,
  "@bb/server-kit/services": services,
  "@bb/server-kit/threads/serial": threadsSerial,
  "@bb/server-kit/threads/thread-display": threadsThreadDisplay,
  "@bb/server-kit/ws/hub": wsHub,
};
