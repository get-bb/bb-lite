import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { normalizeProjectPathInput } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { useHostDirectory } from "@/hooks/queries/host-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

function onEnterOrEscape(enter: () => void, escape: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    if (event.key === "Enter") enter();
    else escape();
  };
}

function BarButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </Button>
  );
}

export function RemotePathBrowser({
  hostId,
  initialPath = null,
  onDirectoryChange,
  disabled = false,
}: {
  hostId: string;
  initialPath?: string | null;
  onDirectoryChange: (directory: string | null) => void;
  disabled?: boolean;
}) {
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [editValue, setEditValue] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isError, error, isPlaceholderData } = useHostDirectory(
    hostId,
    currentPath,
  );
  const directory = data?.directory ?? null;
  useEffect(() => {
    onDirectoryChange(directory);
  }, [directory, onDirectoryChange]);

  const navigateTo = (path: string) => {
    scrollRef.current?.scrollTo({ top: 0 });
    setCurrentPath(path);
  };
  const commitEditor = () => {
    const normalized = normalizeProjectPathInput(editValue ?? "");
    setEditValue(null);
    if (normalized) navigateTo(normalized);
  };
  const segments = directory?.split("/").filter(Boolean) ?? [];
  const crumbs =
    directory === null
      ? []
      : [
          { label: "/", path: "/" },
          ...segments.map((label, index) => ({
            label,
            path: `/${segments.slice(0, index + 1).join("/")}`,
          })),
        ];

  return (
    <div className="flex flex-col rounded-md border">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        {editValue !== null ? (
          <>
            <Input
              autoFocus
              aria-label="Project path"
              className="h-7 flex-1 text-xs"
              value={editValue}
              disabled={disabled}
              placeholder="/path/to/project"
              onChange={(event) => setEditValue(event.target.value)}
              onKeyDown={onEnterOrEscape(commitEditor, () =>
                setEditValue(null),
              )}
            />
            <BarButton
              icon="Check"
              label="Go to path"
              disabled={disabled}
              onClick={commitEditor}
            />
          </>
        ) : (
          <>
            <BarButton
              icon="ArrowUp"
              label="Go to parent folder"
              disabled={disabled || !data?.parent}
              onClick={() => {
                if (data?.parent) navigateTo(data.parent);
              }}
            />
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex items-center">
                  {index > 0 ? (
                    <Icon
                      name="ChevronRight"
                      className="size-3 shrink-0 opacity-50"
                    />
                  ) : null}
                  <button
                    type="button"
                    disabled={disabled}
                    className={cn(
                      "rounded px-1 py-0.5 hover:bg-muted hover:text-foreground",
                      index === crumbs.length - 1 &&
                        "font-medium text-foreground",
                    )}
                    onClick={() => navigateTo(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
            <BarButton
              icon="Edit"
              label="Edit path"
              disabled={disabled}
              onClick={() => setEditValue(directory ?? "")}
            />
          </>
        )}
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "h-56 min-h-0 overflow-y-auto px-1.5 py-1",
          isPlaceholderData && "opacity-60",
        )}
      >
        {isError ? (
          <EmptyState
            icon="AlertCircle"
            message={getMutationErrorMessage({
              error,
              fallbackMessage: "Couldn't read this folder.",
            })}
            messageClassName="text-destructive"
            className="px-2 py-3"
          />
        ) : !data ? (
          <EmptyState
            icon="Spinner"
            iconClassName="animate-spin"
            message="Loading…"
            className="px-2 py-3"
          />
        ) : data.entries.length === 0 ? (
          <EmptyState message="This folder is empty." className="px-2 py-3" />
        ) : (
          <ul className="grid auto-rows-[27px] items-start">
            {data.entries.map((entry) =>
              entry.kind === "file" ? (
                <li
                  key={entry.path}
                  className="flex w-full items-center gap-2 px-2 py-1 text-sm text-muted-foreground"
                >
                  <Icon name="File" className="size-4 shrink-0" />
                  <span className="min-w-0 truncate" title={entry.name}>
                    {entry.name}
                  </span>
                </li>
              ) : (
                <li key={entry.path} className="w-full">
                  <button
                    type="button"
                    disabled={disabled}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none"
                    onClick={() => navigateTo(entry.path)}
                  >
                    <Icon
                      name="Folder"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate" title={entry.name}>
                      {entry.name}
                    </span>
                    <Icon
                      name="ChevronRight"
                      className="ml-auto size-4 shrink-0 text-muted-foreground"
                    />
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
