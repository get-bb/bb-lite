import {
  QUESTION_SELECT_APP_COMMAND_IDS,
  applyAppKeybindingOverrides,
  findAppKeybindingOverride,
  isAppKeybindingAvailableForClient,
  isMacKeyboardPlatform,
  keyboardPlatform,
  keyboardPlatformSchema,
  matchesAppShortcut,
  normalizeAppShortcutInputKey,
  type AppCommandContext,
  type AppDefaultKeybindings,
  type AppKeybinding,
  type AppKeybindingOverrides,
  type AppShortcut,
  type AppShortcutInput,
  type KeyboardCommandId,
} from "@bb/domain";

export interface AppShortcutPresentation {
  ariaKeyshortcuts: string;
  label: string;
}

export function browserPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.closest('[contenteditable]:not([contenteditable="false"])') !==
        null)
  );
}

export function matchesAppCommandContext(
  binding: AppKeybinding,
  context: AppCommandContext,
): boolean {
  return (
    binding.when.all.every((key) => context[key]) &&
    binding.when.none.every((key) => !context[key])
  );
}

const SHORTCUT_KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function heldModifiers(shortcut: AppShortcut, platform: string) {
  const isMac = isMacKeyboardPlatform(platform);
  return {
    isMac,
    control: shortcut.control || (shortcut.mod && !isMac),
    meta: shortcut.meta || (shortcut.mod && isMac),
  };
}

function shortcutParts(
  shortcut: AppShortcut,
  platform: string,
  names: readonly [string, string, string, string],
  key: string,
): string[] {
  const { control, meta } = heldModifiers(shortcut, platform);
  const held = [control, shortcut.alt, shortcut.shift, meta];
  return [...names.filter((_name, index) => held[index]), key];
}

export function formatAppShortcut(
  shortcut: AppShortcut,
  platform: string,
): string {
  const key =
    shortcut.key.length === 1
      ? shortcut.key.toUpperCase()
      : (SHORTCUT_KEY_GLYPHS[shortcut.key] ?? shortcut.key);
  return isMacKeyboardPlatform(platform)
    ? shortcutParts(shortcut, platform, ["⌃", "⌥", "⇧", "⌘"], key).join(" ")
    : shortcutParts(
        shortcut,
        platform,
        ["Ctrl", "Alt", "Shift", "Meta"],
        key,
      ).join(" + ");
}

export function formatAppShortcutAria(
  shortcut: AppShortcut,
  platform: string,
): string {
  return shortcutParts(
    shortcut,
    platform,
    ["Control", "Alt", "Shift", "Meta"],
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key,
  ).join("+");
}

export function presentAppShortcut(
  shortcut: AppShortcut,
  platform: string,
): AppShortcutPresentation {
  return {
    ariaKeyshortcuts: formatAppShortcutAria(shortcut, platform),
    label: formatAppShortcut(shortcut, platform),
  };
}

export function appShortcutMatchesQuery(
  shortcut: AppShortcut,
  platform: string,
  query: string,
): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[\s+]+/u)
    .filter((token) => token.length > 0);
  if (query.trimEnd().endsWith("+")) tokens.push("+");
  const { control, meta } = heldModifiers(shortcut, platform);
  const modifiers = [
    ...(shortcut.mod ? ["mod"] : []),
    ...(meta ? ["cmd", "command", "meta"] : []),
    ...(control ? ["ctrl", "control"] : []),
    ...(shortcut.alt ? ["alt", "opt", "option"] : []),
    ...(shortcut.shift ? ["shift"] : []),
  ];
  const key = shortcut.key.toLowerCase();
  return (
    tokens.length > 0 &&
    tokens.every((token) => modifiers.includes(token) || key.includes(token))
  );
}

const MODIFIER_KEYS = ["Alt", "Control", "Meta", "OS", "Shift"];

export function appShortcutFromInput(
  input: AppShortcutInput,
  platform: string,
): AppShortcut | null {
  const key = normalizeAppShortcutInputKey(input);
  if (
    [...MODIFIER_KEYS, "Dead", "Unidentified"].includes(input.key) ||
    key.length === 0 ||
    key.length > 32
  ) {
    return null;
  }
  const isMac = isMacKeyboardPlatform(platform);
  const mod = isMac ? input.metaKey : input.ctrlKey;
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    mod,
    meta: input.metaKey && !(mod && isMac),
    control: input.ctrlKey && !(mod && !isMac),
    alt: input.altKey,
    shift: input.shiftKey,
  };
}

export function canAssignAppShortcut(
  command: KeyboardCommandId,
  shortcut: AppShortcut,
): boolean {
  return (
    shortcut.mod ||
    shortcut.meta ||
    shortcut.control ||
    shortcut.alt ||
    /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(shortcut.key) ||
    (QUESTION_SELECT_APP_COMMAND_IDS as readonly string[]).includes(command)
  );
}

export function getCommandShortcut(
  defaults: AppDefaultKeybindings,
  overrides: AppKeybindingOverrides,
  command: KeyboardCommandId,
  platform: string,
): AppShortcut | null {
  const binding = defaults
    .filter(
      (candidate) =>
        candidate.command === command &&
        isAppKeybindingAvailableForClient(candidate, { platform }),
    )
    .at(-1);
  if (binding === undefined) return null;
  const override = findAppKeybindingOverride(
    overrides,
    command,
    keyboardPlatform(platform),
  );
  return override === undefined ? binding.shortcut : override.shortcut;
}

export function isAppCommandAvailableForClient(
  defaults: AppDefaultKeybindings,
  command: KeyboardCommandId,
  platform: string,
): boolean {
  return defaults.some(
    (binding) =>
      binding.command === command &&
      isAppKeybindingAvailableForClient(binding, { platform }),
  );
}

export function setCommandShortcutOverride(
  overrides: AppKeybindingOverrides,
  command: KeyboardCommandId,
  shortcut: AppShortcut | null,
  platform: string,
): AppKeybindingOverrides {
  const scope = keyboardPlatform(platform);
  return [
    ...overrides.filter(
      (override) => override.command !== command || override.platform !== scope,
    ),
    { command, shortcut, platform: scope },
  ];
}

export function resetCommandShortcutOverride(
  overrides: AppKeybindingOverrides,
  command: KeyboardCommandId,
  platform: string,
): AppKeybindingOverrides {
  const scope = keyboardPlatform(platform);
  const remaining = overrides.filter(
    (override) =>
      override.command !== command ||
      (override.platform !== undefined && override.platform !== scope),
  );
  const general = overrides.find(
    (override) =>
      override.command === command && override.platform === undefined,
  );
  if (general === undefined) return remaining;
  return [
    ...remaining,
    ...keyboardPlatformSchema.options
      .filter(
        (candidate) =>
          candidate !== scope &&
          !remaining.some(
            (override) =>
              override.command === command && override.platform === candidate,
          ),
      )
      .map((candidate) => ({ ...general, platform: candidate })),
  ];
}

function shortcutsConflict(
  left: AppShortcut,
  right: AppShortcut,
  platform: string,
): boolean {
  const { isMac, control, meta } = heldModifiers(left, platform);
  return matchesAppShortcut(
    {
      key: left.key,
      code: "",
      altKey: left.alt,
      ctrlKey: control,
      metaKey: meta,
      shiftKey: left.shift,
    },
    right,
    isMac,
  );
}

export function getShortcutConflicts(
  defaults: AppDefaultKeybindings,
  overrides: AppKeybindingOverrides,
  command: KeyboardCommandId,
  platform: string,
): KeyboardCommandId[] {
  const shortcut = getCommandShortcut(defaults, overrides, command, platform);
  if (shortcut === null) return [];
  return [...new Set(defaults.map((binding) => binding.command))].filter(
    (candidate) => {
      const other = getCommandShortcut(
        defaults,
        overrides,
        candidate,
        platform,
      );
      return (
        candidate !== command &&
        other !== null &&
        shortcutsConflict(shortcut, other, platform)
      );
    },
  );
}

export function resolvePluginCommandDefaults(
  defaults: AppDefaultKeybindings,
  overrides: AppKeybindingOverrides,
  platform: string,
): {
  defaults: AppDefaultKeybindings;
  conflicts: ReadonlyMap<KeyboardCommandId, readonly KeyboardCommandId[]>;
} {
  const effective = applyAppKeybindingOverrides(defaults, overrides).filter(
    (binding) => isAppKeybindingAvailableForClient(binding, { platform }),
  );
  const scope = keyboardPlatform(platform);
  const conflicts = new Map<KeyboardCommandId, KeyboardCommandId[]>();
  const resolved = defaults.map((binding) => {
    const { command, shortcut } = binding;
    const isCustomized = overrides.some(
      (override) =>
        override.command === command &&
        (override.platform === undefined || override.platform === scope),
    );
    if (!command.startsWith("plugin:") || shortcut === null || isCustomized) {
      return binding;
    }
    const collisions = effective
      .filter(
        (candidate) =>
          candidate.command !== command &&
          shortcutsConflict(shortcut, candidate.shortcut, platform),
      )
      .map((candidate) => candidate.command);
    if (collisions.length === 0) return binding;
    conflicts.set(command, [...new Set(collisions)]);
    return { ...binding, shortcut: null };
  });
  return { defaults: resolved, conflicts };
}
