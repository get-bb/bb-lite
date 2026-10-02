import {
  PERSONAL_PROJECT_ID,
  PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
} from "@bb/domain";
import {
  publicApiRoutes,
  threadTabSchema,
  type ThreadTab,
  type ThreadTabsWireResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { writeRevision } from "../../db/index.js";
import * as sections from "../../db/thread-sections.js";
import { requireThread } from "../../db/threads.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

type WireTab = ThreadTabsWireResponse["tabs"][number];

const OK = { ok: true } as const;
const ACKNOWLEDGED = ["stop", "compact", "clearContext", "unarchive"] as const;

function sectionName(name: string) {
  const trimmed = name.trim();
  if (trimmed === "") throw invalidRequest("Section name cannot be empty");
  return trimmed;
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

export function registerThreadRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, get, patch, post, put } = typedApi(app);
  const routes = publicApiRoutes.threads;
  const sectionRoutes = publicApiRoutes.threadSections;
  const { db, hub, threads } = ctx;
  const announceSections = () =>
    hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);

  post(routes.create, async (c, payload) =>
    c.json(await threads.create(payload), 201),
  );

  patch(routes.update, async (c, payload) =>
    c.json(await threads.update(c.req.param("id"), payload)),
  );

  del(routes.delete, async (c, payload) => {
    await threads.delete(c.req.param("id"), payload);
    return c.json(OK);
  });

  post(routes.send, async (c, payload) =>
    c.json(await threads.send(c.req.param("id"), payload)),
  );

  for (const action of ACKNOWLEDGED) {
    post(routes[action], async (c) => {
      await threads[action](c.req.param("id"));
      return c.json(OK);
    });
  }

  post(routes.archiveAll, async (c) => {
    const archivedThreadIds = await threads.archive(c.req.param("id"));
    return c.json({ ...OK, archivedThreadIds });
  });

  post(routes.pin, async (c) => c.json(await threads.pin(c.req.param("id"))));

  post(routes.unpin, async (c) =>
    c.json(await threads.unpin(c.req.param("id"))),
  );

  patch(routes.pinOrder, async (c, payload) =>
    c.json(await threads.reorderPinned(c.req.param("id"), payload)),
  );

  post(routes.read, async (c) =>
    c.json(await threads.markRead(c.req.param("id"))),
  );

  post(routes.unread, async (c) =>
    c.json(await threads.markUnread(c.req.param("id"))),
  );

  post(routes.createQueuedMessage, async (c, payload) =>
    c.json(await threads.createQueuedMessage(c.req.param("id"), payload), 201),
  );

  patch(routes.setQueuedMessageGroupBoundary, async (c, payload) =>
    c.json(
      await threads.setQueuedMessageGroupBoundary(c.req.param("id"), payload),
    ),
  );

  patch(routes.updateQueuedMessage, async (c, payload) => {
    const { id, queuedMessageId } = c.req.param();
    return c.json(
      await threads.updateQueuedMessage(id, queuedMessageId, payload),
    );
  });

  del(routes.deleteQueuedMessage, async (c) => {
    const { id, queuedMessageId } = c.req.param();
    await threads.deleteQueuedMessage(id, queuedMessageId);
    return c.json(OK);
  });

  post(routes.sendQueuedMessage, async (c, { mode }) => {
    const { id, queuedMessageId } = c.req.param();
    return c.json(
      await threads.sendQueuedMessageNow(id, queuedMessageId, mode),
    );
  });

  patch(routes.reorderQueuedMessage, async (c, payload) => {
    const { id, queuedMessageId } = c.req.param();
    return c.json(
      await threads.reorderQueuedMessage(id, queuedMessageId, payload),
    );
  });

  post(routes.resolveInteraction, async (c, payload) => {
    const { id, interactionId } = c.req.param();
    return c.json(await threads.resolveInteraction(id, interactionId, payload));
  });

  post(routes.respondToInteraction, async (c, { value }) => {
    const { id, interactionId } = c.req.param();
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES) {
      const message = "Interaction response exceeds 64 KiB";
      throw new ApiError(413, "invalid_request", message);
    }
    return c.json(await threads.respondToInteraction(id, interactionId, value));
  });

  post(routes.cancelInteraction, async (c) => {
    const { id, interactionId } = c.req.param();
    return c.json(await threads.cancelInteraction(id, interactionId));
  });

  post(routes.open, (c, payload) => {
    const { projectId, id: threadId } = requireThread(db, c.req.param("id"));
    const { file } = payload;
    if (file !== null && file.path.split("/").includes("..")) {
      throw invalidRequest("File path must stay inside its root.");
    }
    const split = payload.split ?? "replace";
    const delivered = hub.threadOpen({ projectId, threadId, split, file });
    return c.json({ delivered });
  });

  get(routes.tabs, (c) => {
    const { id } = requireThread(db, c.req.param("id"));
    const stored = db.get<{ revision: number; tabsJson: string }>(
      "SELECT revision, tabs_json FROM thread_tabs WHERE thread_id = ?",
      id,
    );
    if (stored === undefined) return c.json({ revision: 0, tabs: [] });
    const { revision, tabsJson } = stored;
    return c.json({ revision, tabs: storedWireTabs(tabsJson) });
  });

  put(routes.updateTabs, (c, { expectedRevision, tabs }) => {
    const { id } = requireThread(db, c.req.param("id"));
    const row = { threadId: id, tabsJson: JSON.stringify(tabs) };
    const expected = expectedRevision;
    const write = writeRevision(db, "thread_tabs", "threadId", row, expected);
    const { revision } = write;
    if (write.outcome === "conflict") {
      const message = "Thread tabs changed on another client";
      const details = { currentRevision: revision };
      throw new ApiError(409, "thread_tabs_conflict", message, { details });
    }
    hub.thread(id, ["tabs-changed"]);
    return c.json({ revision, tabs: tabs.map(toWireTab) });
  });

  get(sectionRoutes.list, (c) => c.json(sections.listThreadSections(db)));

  post(sectionRoutes.create, (c, payload) => {
    const name = sectionName(payload.name);
    const section = sections.createThreadSection(db, name);
    announceSections();
    return c.json(section, 201);
  });

  patch(sectionRoutes.update, (c, payload) => {
    const name = sectionName(payload.name);
    const renamed = sections.renameThreadSection(db, payload.id, name);
    announceSections();
    return c.json(renamed);
  });

  del(sectionRoutes.delete, (c, payload) => {
    const deleted = sections.deleteThreadSection(db, payload.id);
    const { threads: moved, ...result } = deleted;
    for (const { id, projectId } of moved) {
      hub.thread(id, ["title-changed"], { projectId });
    }
    const projectIds = moved.map((thread) => thread.projectId);
    for (const projectId of new Set([PERSONAL_PROJECT_ID, ...projectIds])) {
      hub.project(projectId, ["threads-changed"]);
    }
    return c.json(result);
  });
}
