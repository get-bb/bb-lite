import {
  publicApiRoutes,
  threadTabSchema,
  type ThreadTab,
  type ThreadTabsWireResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import type { Db } from "../../db/index.js";
import {
  readThreadTabs,
  threadExists,
  writeThreadTabs,
} from "../../db/thread-tabs.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError } from "../errors.js";

type WireTab = ThreadTabsWireResponse["tabs"][number];

function requireThreadId(db: Db, threadId: string): string {
  if (threadExists(db, threadId)) return threadId;
  throw new ApiError(404, "thread_not_found", "Thread not found");
}

function toWireTab(tab: ThreadTab): WireTab {
  if (tab.kind === "host-file-preview") {
    const { hostId, ...rest } = tab;
    return hostId === null ? rest : tab;
  }
  if (
    tab.kind === "plugin-panel" &&
    tab.fileOpenerOwner?.kind === "host-file-preview"
  ) {
    const { hostId, ...owner } = tab.fileOpenerOwner;
    return hostId === null ? { ...tab, fileOpenerOwner: owner } : tab;
  }
  return tab;
}

function storedWireTabs(tabsJson: string): WireTab[] {
  const parsed: unknown = JSON.parse(tabsJson);
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [];
  return candidates.flatMap((candidate) => {
    const tab = threadTabSchema.safeParse(candidate);
    return tab.success ? [toWireTab(tab.data)] : [];
  });
}

export function registerThreadTabRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, put } = typedApi(app);
  const routes = publicApiRoutes.threads;
  const { db } = ctx;

  get(routes.tabs, (c) => {
    const stored = readThreadTabs(db, requireThreadId(db, c.req.param("id")));
    if (stored === undefined) return c.json({ revision: 0, tabs: [] });
    const { revision, tabsJson } = stored;
    return c.json({ revision, tabs: storedWireTabs(tabsJson) });
  });

  put(routes.updateTabs, (c, payload) => {
    const threadId = requireThreadId(db, c.req.param("id"));
    const { expectedRevision, tabs } = payload;
    const tabsJson = JSON.stringify(tabs);
    const write = writeThreadTabs(db, { threadId, tabsJson, expectedRevision });
    if (write.outcome === "conflict") {
      throw new ApiError(
        409,
        "thread_tabs_conflict",
        "Thread tabs changed on another client",
        { details: { currentRevision: write.revision } },
      );
    }
    ctx.hub.thread(threadId, ["tabs-changed"]);
    return c.json({ revision: write.revision, tabs: tabs.map(toWireTab) });
  });
}
