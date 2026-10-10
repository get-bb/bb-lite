import { sections, threads, type PluginServerApi } from "@bb/plugin";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  threadTabSchema,
  type ThreadTab,
  type ThreadTabsWireResponse,
} from "@bb/server-contract";
import { actorUserId, viewerId } from "@bb/server-kit/auth/actor";
import { writeRevision } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/thread-sections";
import { requireThread } from "@bb/server-kit/db/threads";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";

type WireTab = ThreadTabsWireResponse["tabs"][number];

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

export function implementThreadViews(bb: PluginServerApi): void {
  const { db, realtime: hub } = bb;
  const announceSections = () =>
    hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);

  bb.implement(threads.open, (input) => {
    const { projectId, id: threadId } = requireThread(db, input.threadId);
    const { file } = input;
    if (file !== null && file.path.split("/").includes("..")) {
      throw invalidRequest("File path must stay inside its root.");
    }
    const split = input.split ?? "replace";
    const signal = { projectId, threadId, split, file };
    return { delivered: hub.threadOpen(signal, actorUserId()) };
  });

  bb.implement(threads.tabs, ({ threadId }) => {
    const { id } = requireThread(db, threadId);
    const stored = db.get<{ revision: number; tabsJson: string }>(
      `SELECT revision, tabs_json FROM thread_tabs
       WHERE thread_id = ? AND user_id = ?`,
      id,
      viewerId(),
    );
    if (stored === undefined) return { revision: 0, tabs: [] };
    const { revision, tabsJson } = stored;
    return { revision, tabs: storedWireTabs(tabsJson) };
  });

  bb.implement(threads.updateTabs, ({ threadId, expectedRevision, tabs }) => {
    const { id } = requireThread(db, threadId);
    const key = { threadId: id, userId: viewerId() };
    const values = { tabsJson: JSON.stringify(tabs) };
    const expected = expectedRevision;
    const write = writeRevision(db, "thread_tabs", key, values, expected);
    const { revision } = write;
    if (write.outcome === "conflict") {
      const message = "Thread tabs changed on another client";
      const details = { currentRevision: revision };
      throw new ApiError(409, "thread_tabs_conflict", message, { details });
    }
    hub.thread(id, ["tabs-changed"]);
    return { revision, tabs: tabs.map(toWireTab) };
  });

  bb.implement(sections.list, () => store.listThreadSections(db));

  bb.implement(sections.create, (input) => {
    const section = store.createThreadSection(db, sectionName(input.name));
    announceSections();
    return section;
  });

  bb.implement(sections.update, (input) => {
    const name = sectionName(input.name);
    const renamed = store.renameThreadSection(db, input.id, name);
    announceSections();
    return renamed;
  });

  bb.implement(sections.delete, (input) => {
    const deleted = store.deleteThreadSection(db, input.id);
    const { threads: moved, ...result } = deleted;
    for (const { id, projectId } of moved) {
      hub.thread(id, ["title-changed"], { projectId });
    }
    const projectIds = moved.map((thread) => thread.projectId);
    for (const projectId of new Set([PERSONAL_PROJECT_ID, ...projectIds])) {
      hub.project(projectId, ["threads-changed"]);
    }
    return result;
  });
}
