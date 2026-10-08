import { useState } from "react";
import {
  defaultAppSettings,
  findAppKeybindingOverride,
  keyboardPlatform,
  pluginCommandId,
  type AppKeybindingOverrides,
  type AppShortcut,
  type KeyboardCommandId,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { AppCommandShortcutPill } from "@bb/shared-ui/app-command-shortcut-pill";
import { SettingsSwitch } from "./SettingsDropdown";
import {
  SettingsBadge,
  SettingsSection,
} from "@bb/app-kit/components/ui/settings-section";
import {
  useUpdateGeneralSettings,
  useUpdateKeyboardSettings,
} from "@bb/app-kit/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@bb/app-kit/hooks/queries/system-queries";
import { usePluginCommandBindings } from "@bb/app-kit/hooks/usePluginCommandBindings";
import { APP_COMMAND_GROUPS } from "@bb/app-kit/lib/app-command-metadata";
import {
  appShortcutFromInput,
  appShortcutMatchesQuery,
  browserPlatform,
  canAssignAppShortcut,
  getCommandShortcut,
  getShortcutConflicts,
  isAppCommandAvailableForClient,
  presentAppShortcut,
  resetCommandShortcutOverride,
  setCommandShortcutOverride,
} from "@bb/app-kit/lib/app-keybindings";

interface CommandRow {
  command: KeyboardCommandId;
  label: string;
  description: string;
}

function ShortcutRecorder({
  row,
  disabled,
  onChange,
  onRecordingChange,
  recording,
  shortcut,
}: {
  row: CommandRow;
  disabled: boolean;
  onChange: (shortcut: AppShortcut) => void;
  onRecordingChange: (recording: boolean) => void;
  recording: boolean;
  shortcut: AppShortcut | null;
}) {
  const platform = browserPlatform();
  const [error, setError] = useState<string | null>(null);
  const presentation =
    shortcut === null ? null : presentAppShortcut(shortcut, platform);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        aria-label={
          recording
            ? `Recording shortcut for ${row.label}. Press keys or Escape to cancel.`
            : `Record shortcut for ${row.label}, current shortcut ${presentation?.label ?? "unassigned"}`
        }
        aria-pressed={recording}
        className={cn(
          "h-7 min-w-24 px-2 text-xs",
          recording && "border-ring text-foreground",
        )}
        disabled={disabled}
        onBlur={() => {
          setError(null);
          onRecordingChange(false);
        }}
        onClick={() => {
          if (recording) return;
          setError(null);
          onRecordingChange(true);
        }}
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          const next =
            event.key === "Escape"
              ? undefined
              : appShortcutFromInput(event, platform);
          if (next === null) return setError("Press a non-modifier key.");
          if (next !== undefined && !canAssignAppShortcut(row.command, next))
            return setError("Use Command, Control, or Alt with a key.");
          setError(null);
          if (next !== undefined) onChange(next);
          onRecordingChange(false);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {recording ? (
          "Press keys"
        ) : presentation === null ? (
          "Unassigned"
        ) : (
          <AppCommandShortcutPill
            className="rounded-none bg-transparent px-0 py-0 text-foreground opacity-100"
            shortcut={presentation}
          />
        )}
      </Button>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function KeyboardSettingsSection() {
  const systemConfig = useSystemConfig();
  const updateGeneralSettings = useUpdateGeneralSettings();
  const updateKeyboard = useUpdateKeyboardSettings();
  const platform = browserPlatform();
  const generalSettings =
    systemConfig.data?.generalSettings ?? defaultAppSettings;
  const bindings = usePluginCommandBindings();
  const { defaults } = bindings;
  const overrides = systemConfig.data?.keybindingOverrides ?? [];
  const [pendingAssignment, setPendingAssignment] = useState<{
    command: KeyboardCommandId;
    shortcut: AppShortcut;
    conflicts: KeyboardCommandId[];
  } | null>(null);
  const [recordingCommand, setRecordingCommand] =
    useState<KeyboardCommandId | null>(null);
  const [changedCommand, setChangedCommand] =
    useState<KeyboardCommandId | null>(null);
  const [search, setSearch] = useState("");

  const groups: readonly { label: string; commands: readonly CommandRow[] }[] =
    [
      ...APP_COMMAND_GROUPS,
      {
        label: "Plugin commands",
        commands: bindings.commands.map((command) => ({
          command: pluginCommandId(command.pluginId, command.id),
          label: command.title,
          description: `Plugin: ${command.pluginId}`,
        })),
      },
    ];
  const rows = groups.flatMap((group) => group.commands);
  const labelOf = (id: KeyboardCommandId) =>
    rows.find((row) => row.command === id)?.label ?? id;
  const shortcutOf = (command: KeyboardCommandId) =>
    getCommandShortcut(defaults, overrides, command, platform);
  const defaultShortcutOf = (command: KeyboardCommandId) =>
    getCommandShortcut(defaults, [], command, platform);
  const isAvailable = (command: KeyboardCommandId) =>
    isAppCommandAvailableForClient(defaults, command, platform);
  const isCustomized = (command: KeyboardCommandId) =>
    findAppKeybindingOverride(
      overrides,
      command,
      keyboardPlatform(platform),
    ) !== undefined;

  const apply = (
    next: AppKeybindingOverrides,
    command: KeyboardCommandId | null,
  ) => {
    setChangedCommand(command);
    setPendingAssignment(null);
    updateKeyboard.mutate(next);
  };
  const assign = (
    command: KeyboardCommandId,
    shortcut: AppShortcut | null,
    replace: boolean,
  ) => {
    let next = setCommandShortcutOverride(
      overrides,
      command,
      shortcut,
      platform,
    );
    const conflicts = getShortcutConflicts(defaults, next, command, platform);
    if (shortcut !== null && conflicts.length > 0 && !replace)
      return setPendingAssignment({ command, shortcut, conflicts });
    if (replace)
      for (const conflict of conflicts)
        next = setCommandShortcutOverride(next, conflict, null, platform);
    apply(next, command);
  };

  const query = search.trim().toLowerCase();
  const matches = rows
    .map((row) => {
      const label = row.label.toLowerCase();
      const rank = [
        label === query,
        label.startsWith(query),
        label.includes(query),
        [shortcutOf(row.command), defaultShortcutOf(row.command)].some(
          (shortcut) =>
            shortcut !== null &&
            appShortcutMatchesQuery(shortcut, platform, query),
        ),
        row.command.toLowerCase().includes(query),
        row.description.toLowerCase().includes(query),
      ].findIndex(Boolean);
      return { row, rank };
    })
    .filter(({ rank }) => rank !== -1)
    .sort((left, right) => left.rank - right.rank)
    .map(({ row }) => row);
  const visibleGroups =
    query.length === 0
      ? groups
      : matches.length === 0
        ? []
        : [{ label: "Search results", commands: matches }];

  const pending = updateKeyboard.isPending;
  const disabled = systemConfig.data === undefined || pending;
  const customized = rows.filter(
    (row) => isAvailable(row.command) && isCustomized(row.command),
  );

  return (
    <SettingsSection
      action={
        <Button
          disabled={disabled || customized.length === 0}
          onClick={() =>
            apply(
              customized.reduce(
                (next, row) =>
                  resetCommandShortcutOverride(next, row.command, platform),
                overrides,
              ),
              null,
            )
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Reset all
        </Button>
      }
      description="Click a shortcut, then press its new keys. Changes sync to every bb window."
      title="Keyboard shortcuts"
    >
      <div className="space-y-5">
        <SettingsSwitch
          label="Show keyboard hints when holding CMD / Control"
          description="Show shortcut badges after holding Command or Control."
          checked={generalSettings.showKeyboardHints}
          disabled={
            systemConfig.data === undefined || updateGeneralSettings.isPending
          }
          onChange={(showKeyboardHints) =>
            updateGeneralSettings.mutate({
              ...generalSettings,
              showKeyboardHints,
            })
          }
        />
        <Input
          aria-label="Search keyboard shortcuts"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search shortcuts"
          value={search}
        />
        {pendingAssignment !== null ? (
          <div
            role="alert"
            className="space-y-2 rounded border border-border p-3"
          >
            <p className="text-sm">
              Shortcut already used by{" "}
              {pendingAssignment.conflicts.map(labelOf).join(", ")}. Replace it
              with {labelOf(pendingAssignment.command)}?
            </p>
            <div className="flex gap-2">
              <Button
                disabled={disabled}
                onClick={() =>
                  assign(
                    pendingAssignment.command,
                    pendingAssignment.shortcut,
                    true,
                  )
                }
                size="sm"
              >
                Replace binding
              </Button>
              <Button
                onClick={() => setPendingAssignment(null)}
                size="sm"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <fieldset
          className={cn(
            "m-0 min-w-0 space-y-5 border-0 p-0",
            pending && "[&:disabled_button:not([disabled])]:opacity-100",
          )}
          disabled={disabled}
        >
          {visibleGroups.map((group) => (
            <section key={group.label}>
              <h3 className="mb-2 text-xs font-medium text-subtle-foreground">
                {group.label}
              </h3>
              <div className="divide-y divide-border">
                {group.commands.map((row) => {
                  const { command } = row;
                  const available = isAvailable(command);
                  const custom = isCustomized(command);
                  const shortcut = shortcutOf(command);
                  const defaultShortcut = defaultShortcutOf(command);
                  const defaultConflicts = bindings.conflicts.get(command);
                  const conflicts = custom
                    ? getShortcutConflicts(
                        defaults,
                        overrides,
                        command,
                        platform,
                      )
                    : [];
                  const busy = pending && changedCommand === command;
                  return (
                    <div
                      key={command}
                      aria-busy={busy || undefined}
                      className={cn(
                        "flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-5",
                        busy && "opacity-50",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-sm text-foreground">{row.label}</p>
                          {custom ? (
                            <SettingsBadge>Custom</SettingsBadge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
                          {row.description}
                        </p>
                        {defaultShortcut !== null ? (
                          <div
                            aria-label={`Default shortcut for ${row.label}`}
                            className="mt-1.5 flex flex-wrap items-center gap-1.5"
                          >
                            <span className="text-xs text-subtle-foreground/75">
                              Default:
                            </span>
                            <AppCommandShortcutPill
                              ariaHidden={false}
                              className="bg-muted/40 px-1.5 py-0.5 text-foreground opacity-100"
                              shortcut={presentAppShortcut(
                                defaultShortcut,
                                platform,
                              )}
                            />
                          </div>
                        ) : null}
                        {defaultConflicts?.length ? (
                          <p className="mt-1 text-xs text-warning-text">
                            Default shortcut left unbound: also used by{" "}
                            {defaultConflicts.map(labelOf).join(", ")}.
                          </p>
                        ) : null}
                        {conflicts.length > 0 ? (
                          <p className="mt-1 text-xs text-warning-text">
                            Also used by {conflicts.map(labelOf).join(", ")}.
                            Context determines which command runs.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-start justify-end gap-1">
                        <ShortcutRecorder
                          row={row}
                          disabled={!available}
                          onChange={(next) => assign(command, next, false)}
                          onRecordingChange={(recording) =>
                            setRecordingCommand(recording ? command : null)
                          }
                          recording={recordingCommand === command}
                          shortcut={shortcut}
                        />
                        <Button
                          aria-label={`Clear shortcut for ${row.label}`}
                          className="size-7"
                          disabled={!available || shortcut === null}
                          onClick={() => assign(command, null, false)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Icon name="X" className="size-3.5" />
                        </Button>
                        <Button
                          aria-label={`Reset shortcut for ${row.label}`}
                          className="size-7"
                          disabled={!available || !custom}
                          onClick={() =>
                            apply(
                              resetCommandShortcutOverride(
                                overrides,
                                command,
                                platform,
                              ),
                              command,
                            )
                          }
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Icon name="RotateCcw" className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {visibleGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-subtle-foreground">
              No shortcuts match “{search}”.
            </p>
          ) : null}
        </fieldset>
      </div>
    </SettingsSection>
  );
}
