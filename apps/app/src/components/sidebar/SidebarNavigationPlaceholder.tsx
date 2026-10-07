import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { createLastKnownCache } from "@/lib/last-known-cache";
import { SETTINGS_PLUGINS_ROUTE_PATH } from "@/lib/route-paths";

type UnavailableState =
  | { kind: "missing" }
  | { kind: "crashed"; pluginTitle: string; onReload: () => void };

const LOADING_ROW_PITCH = 30;
const LOADING_ROW_WIDTHS = ["w-1/2", "w-2/5", "w-1/3", "w-2/5", "w-1/2"];

const heightCache = createLastKnownCache({
  prefix: "bb.sidebar-navigation-height",
  version: "1",
  schema: z.number().int().nonnegative(),
  maxEntries: 8,
});

export function readRememberedNavigationHeight(
  providerKey: string,
): number | null {
  return heightCache.read(heightCache.key(providerKey));
}

export function rememberNavigationHeight(
  providerKey: string,
  height: number,
): void {
  const key = heightCache.key(providerKey);
  if (heightCache.read(key) !== height) heightCache.write(key, height);
}

function LoadingRow({
  widthClassName,
  inset,
}: {
  widthClassName: string;
  inset: boolean;
}) {
  return (
    <div
      data-sidebar={inset ? undefined : "navigation-loading-row"}
      className={cn(
        "flex h-7 items-center rounded-md",
        inset ? "px-2" : "gap-2",
      )}
    >
      {inset ? null : (
        <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      )}
      <Skeleton
        className={cn("h-3 rounded-sm bg-sidebar-border/50", widthClassName)}
      />
    </div>
  );
}

function Unavailable({
  attribute,
  state,
  missingText,
  missingAction,
}: {
  attribute: string;
  state: UnavailableState;
  missingText: string;
  missingAction?: ReactNode;
}) {
  const isMissing = state.kind === "missing";
  return (
    <div
      role={isMissing ? "status" : "alert"}
      {...{ [attribute]: state.kind }}
      className="flex flex-col gap-2 px-3 py-2 text-sm text-muted-foreground"
    >
      <span>
        {isMissing ? missingText : `${state.pluginTitle} stopped working.`}
      </span>
      {isMissing ? (
        missingAction
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={state.onReload}
        >
          Reload
        </Button>
      )}
    </div>
  );
}

export function SidebarNavigationPlaceholder({
  state,
  onNavigate,
}: {
  state: { kind: "loading"; height: number | null } | UnavailableState;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  if (state.kind === "loading") {
    if (state.height === 0) return null;
    const rows =
      state.height === null
        ? 4
        : Math.max(1, Math.floor(state.height / LOADING_ROW_PITCH));
    return (
      <div
        aria-label="Loading sidebar navigation"
        data-sidebar-navigation-placeholder="loading"
        className="space-y-0.5 overflow-hidden px-2 py-2"
        style={state.height === null ? undefined : { height: state.height }}
      >
        {Array.from({ length: rows }, (_, index) => (
          <LoadingRow
            key={index}
            inset
            widthClassName={
              LOADING_ROW_WIDTHS[index % LOADING_ROW_WIDTHS.length] ?? "w-1/2"
            }
          />
        ))}
      </div>
    );
  }
  return (
    <Unavailable
      attribute="data-sidebar-navigation-placeholder"
      state={state}
      missingText="No navigation plugin is enabled."
      missingAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            onNavigate?.();
            void navigate(SETTINGS_PLUGINS_ROUTE_PATH);
          }}
        >
          Open Plugins
        </Button>
      }
    />
  );
}

export function ThreadListPlaceholder({
  state,
}: {
  state: { kind: "loading" } | UnavailableState;
}) {
  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading sidebar navigation"
        data-thread-list-placeholder="loading"
        className="p-2"
      >
        <div className="space-y-1.5 px-2 pt-1">
          <LoadingRow inset={false} widthClassName="w-2/3" />
          <LoadingRow inset={false} widthClassName="w-1/2" />
        </div>
      </div>
    );
  }
  return (
    <Unavailable
      attribute="data-thread-list-placeholder"
      state={state}
      missingText="No thread list plugin is enabled."
    />
  );
}
