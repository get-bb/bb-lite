import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeProjectPathInput } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { invalidateHostDirectoryListing } from "@/hooks/cache-owners/host-directory-cache-owner";
import { useHostDirectory } from "@/hooks/queries/host-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

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
  spin,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
  spin?: boolean;
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
      <Icon name={icon} className={cn(spin && "animate-spin")} />
    </Button>
  );
}

export function RemotePathBrowser({
  hostId,
  initialPath = null,
  allowCreateFolder,
  onDirectoryChange,
  disabled = false,
}: {
  hostId: string;
  initialPath?: string | null;
  allowCreateFolder: boolean;
  onDirectoryChange: (directory: string | null) => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [editValue, setEditValue] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isError, error, isPlaceholderData } = useHostDirectory(
    hostId,
    currentPath,
  );
  const directory = data?.directory ?? null;
  useEffect(() => {
    onDirectoryChange(directory);
  }, [directory, onDirectoryChange]);

  const closeNewFolder = () => {
    setNewFolderName(null);
    setNewFolderError(null);
  };
  const navigateTo = (path: string) => {
    closeNewFolder();
    scrollRef.current?.scrollTo({ top: 0 });
    setCurrentPath(path);
  };
  const createFolder = useMutation({
    mutationFn: async ({ parent, name }: { parent: string; name: string }) => {
      const path = `${parent.replace(/\/+$/, "")}/${name}`;
      await sdk.files.mkdir({ hostId, path });
      return path;
    },
    onSuccess: async (path, { parent }) => {
      navigateTo(path);
      await invalidateHostDirectoryListing({
        queryClient,
        hostId,
        directory: parent,
      });
    },
    onError: (mutationError) =>
      setNewFolderError(
        getMutationErrorMessage({
          error: mutationError,
          fallbackMessage: "Couldn't create that folder.",
        }),
      ),
  });
  const busy = disabled || createFolder.isPending;
  const canCreateHere =
    !busy && directory !== null && !isError && !isPlaceholderData;
  const commitNewFolder = () => {
    if (!canCreateHere) return;
    const name = (newFolderName ?? "").trim();
    if (!name || name === "." || name === "..")
      return setNewFolderError("Enter a folder name.");
    if (/[\\/]/.test(name))
      return setNewFolderError("Folder names can't contain slashes.");
    setNewFolderError(null);
    createFolder.mutate({ parent: directory, name });
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
              disabled={busy || !data?.parent}
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
                    disabled={busy}
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
            {allowCreateFolder ? (
              <BarButton
                icon="FolderPlus"
                label="New folder"
                disabled={!canCreateHere}
                onClick={() => setNewFolderName("")}
              />
            ) : null}
            <BarButton
              icon="Edit"
              label="Edit path"
              disabled={busy}
              onClick={() => {
                closeNewFolder();
                setEditValue(directory ?? "");
              }}
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
        {newFolderName !== null ? (
          <div
            role="group"
            aria-label="Create new folder"
            className="mb-1 flex flex-col gap-1"
          >
            <div className="flex items-center gap-2 px-2">
              <Icon
                name="Folder"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <Input
                autoFocus
                aria-label="New folder name"
                className="-ml-1 h-7 min-w-0 flex-1 px-1 text-sm"
                value={newFolderName}
                disabled={busy}
                placeholder="Folder name"
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  setNewFolderError(null);
                }}
                onKeyDown={onEnterOrEscape(commitNewFolder, closeNewFolder)}
              />
              <div className="flex shrink-0 items-center gap-0.5">
                <BarButton
                  icon={createFolder.isPending ? "Spinner" : "Check"}
                  spin={createFolder.isPending}
                  label="Create folder"
                  disabled={busy}
                  onClick={commitNewFolder}
                />
                <BarButton
                  icon="X"
                  label="Cancel new folder"
                  disabled={busy}
                  onClick={closeNewFolder}
                />
              </div>
            </div>
            {newFolderError ? (
              <p role="alert" className="px-2 text-xs text-destructive">
                {newFolderError}
              </p>
            ) : null}
          </div>
        ) : null}
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
                    disabled={busy}
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
