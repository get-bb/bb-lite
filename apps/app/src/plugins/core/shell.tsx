import { lazy, Suspense } from "react";
import { Navigate } from "react-router-dom";
import { isThreadRead } from "@bb/client-core";
import type { Thread } from "@bb/domain";
import {
  definePluginApp,
  shell,
  type ShellNavItem,
  type ShellRoute,
  type ThreadAction,
  type ThreadActionContext,
} from "@bb/plugin/app";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  getSettingsRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";

const SettingsView = lazy(() =>
  import("@/views/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const ProjectDetailSettingsView = lazy(() =>
  import("@/views/ProjectDetailSettingsView").then((m) => ({
    default: m.ProjectDetailSettingsView,
  })),
);
const MachineSettingsView = lazy(() =>
  import("@/views/MachineSettingsView").then((m) => ({
    default: m.MachineSettingsView,
  })),
);
const splitWorkspaceRouteModule = import("@/views/SplitWorkspaceRoute");
splitWorkspaceRouteModule.catch(() => {});
const SplitWorkspaceRoute = lazy(() => splitWorkspaceRouteModule);

function ArchivedRedirect() {
  return <Navigate to={getSettingsRoutePath("archived")} replace />;
}

function WorkspaceRoute() {
  return (
    <Suspense fallback={<RouteLoadingSkeleton isBoundedPane={false} />}>
      <SplitWorkspaceRoute />
    </Suspense>
  );
}

const ROUTES: readonly ShellRoute[] = [
  { id: "settings", path: SETTINGS_ROUTE_PATH, view: SettingsView },
  {
    id: "settings-section",
    path: SETTINGS_SECTION_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-plugins",
    path: SETTINGS_PLUGINS_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-plugin",
    path: SETTINGS_PLUGIN_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-machine",
    path: SETTINGS_MACHINE_ROUTE_PATH,
    view: MachineSettingsView,
  },
  {
    id: "settings-project",
    path: SETTINGS_PROJECT_ROUTE_PATH,
    view: ProjectDetailSettingsView,
  },
  {
    id: "projectless-archived",
    path: PROJECTLESS_ARCHIVED_ROUTE_PATH,
    view: ArchivedRedirect,
  },
  { id: "workspace", path: "*", view: WorkspaceRoute },
];

const NAV_ITEMS: readonly ShellNavItem[] = [
  {
    id: "home",
    label: "Home",
    icon: "Home",
    position: "top",
    order: 10,
    to: (context) => context.homeRoutePath,
    isActive: (context) => context.isHomeActive,
  },
  {
    id: "settings",
    label: "Settings",
    icon: "Settings",
    position: "bottom",
    order: 10,
    command: "settings.open",
    to: (context) => context.settingsRoutePath,
    isActive: (context) => context.isSettingsActive,
  },
];

function afterMenuCloses(run: (thread: Thread) => void) {
  return ({ thread }: ThreadActionContext) => {
    window.setTimeout(() => run(thread), 0);
  };
}

function isInSection(thread: Thread, sectionId: string | null): boolean {
  return thread.pinnedAt === null && thread.sectionId === sectionId;
}

const THREAD_ACTIONS: readonly ThreadAction[] = [
  {
    id: "copy-link",
    label: "Copy thread link",
    icon: "Copy",
    order: 10,
    run: ({ thread }) => {
      void copyToClipboardWithToast(
        new URL(
          getThreadRoutePath({
            projectId: thread.projectId,
            threadId: thread.id,
          }),
          window.location.origin,
        ).toString(),
        {
          successMessage: "Thread link copied",
          errorMessage: "Failed to copy thread link",
        },
      );
    },
  },
  {
    id: "toggle-read",
    label: ({ thread }) => (isThreadRead(thread) ? "Mark unread" : "Mark read"),
    icon: ({ thread }) => (isThreadRead(thread) ? "Mail" : "MailOpen"),
    order: 20,
    run: ({ thread, actions }) => actions.toggleRead(thread),
  },
  {
    id: "toggle-pin",
    label: ({ thread }) => (thread.pinnedAt !== null ? "Unpin" : "Pin"),
    icon: ({ thread }) => (thread.pinnedAt !== null ? "PinOff" : "Pin"),
    order: 30,
    run: ({ thread, actions }) => actions.togglePin(thread),
  },
  {
    id: "move-to-section",
    label: "Move to section",
    icon: "SectionMove",
    order: 40,
    isAvailable: ({ thread, actions }) =>
      thread.parentThreadId === null &&
      thread.archivedAt === null &&
      !actions.sectionDestinations.every(({ sectionId }) =>
        isInSection(thread, sectionId),
      ),
    choices: ({ thread, actions }) =>
      actions.sectionDestinations.map(({ sectionId, label }) => ({
        id: sectionId ?? "threads",
        label,
        isCurrent: isInSection(thread, sectionId),
        run: () => actions.moveToSection(thread, sectionId),
      })),
  },
  {
    id: "rename",
    label: "Rename",
    icon: "Edit",
    order: 50,
    run: (context) => afterMenuCloses(context.actions.requestRename)(context),
  },
  {
    id: "toggle-archive",
    label: ({ thread }) =>
      thread.archivedAt != null ? "Unarchive" : "Archive",
    icon: ({ thread }) =>
      thread.archivedAt != null ? "ArchiveRestore" : "Archive",
    order: 60,
    group: "remove",
    run: (context) =>
      context.thread.archivedAt != null
        ? context.actions.unarchiveThread(context.thread)
        : afterMenuCloses(context.actions.requestArchive)(context),
  },
  {
    id: "delete",
    label: "Delete",
    icon: "Trash2",
    variant: "destructive",
    order: 70,
    group: "remove",
    run: (context) => afterMenuCloses(context.actions.requestDelete)(context),
  },
];

export default definePluginApp((bb) => {
  for (const route of ROUTES) bb.add(shell.route, route);
  for (const item of NAV_ITEMS) bb.add(shell.navItem, item);
  for (const action of THREAD_ACTIONS) bb.add(shell.threadAction, action);
});
