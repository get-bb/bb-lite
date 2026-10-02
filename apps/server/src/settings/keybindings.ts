import * as domain from "@bb/domain";

interface When {
  all: readonly domain.AppCommandContextKey[];
  none: readonly domain.AppCommandContextKey[];
}

const MODIFIERS = ["mod", "meta", "control", "alt", "shift"] as const;

function when(
  all: domain.AppCommandContextKey[],
  none: domain.AppCommandContextKey[] = ["modalOpen"],
): When {
  return { all: ["mainSurface", ...all], none };
}

const main = when([]);
const webMain = when(["webSurface"]);
const split = when(["splitActive"]);
const pickerOpen = when(["modelPickerOpen"], []);
const question = when(["questionOpen"], ["modalOpen", "editableFocus"]);
const outsideEditors = when(
  [],
  ["modalOpen", "editableFocus", "terminalFocus", "browserFocus"],
);
const composer = when(
  ["promptAvailable"],
  ["modalOpen", "terminalFocus", "browserFocus"],
);

function parseShortcut(keys: string) {
  const parts = keys.split("+");
  const held = new Set(parts.slice(0, -1));
  const [mod, meta, control, alt, shift] = MODIFIERS.map((modifier) =>
    held.has(modifier),
  );
  return { key: parts.at(-1) ?? "", mod, meta, control, alt, shift };
}

function bind(
  command: domain.AppCommandId,
  keys: string | null,
  when: When,
): domain.AppDefaultKeybinding {
  return {
    command,
    desktopOnly: false,
    shortcut: keys === null ? null : parseShortcut(keys),
    when: { all: [...when.all], none: [...when.none] },
  };
}

function onMac(when: When): When {
  return { all: [...when.all, "macPlatform"], none: when.none };
}

function offMac(when: When): When {
  return { all: when.all, none: [...when.none, "macPlatform"] };
}

function macOnly(
  command: domain.AppCommandId,
  keys: string,
  when: When,
): domain.AppDefaultKeybindings {
  return [bind(command, keys, onMac(when)), bind(command, null, offMac(when))];
}

function numbered(
  commands: readonly domain.AppCommandId[],
  when: When,
): domain.AppDefaultKeybindings {
  const web: When = { all: [...when.all, "webSurface"], none: when.none };
  return commands.flatMap((command, index) => [
    bind(command, `control+${index + 1}`, onMac(web)),
    bind(command, `mod+shift+${index + 1}`, offMac(web)),
  ]);
}

function modelPicker(when: When): domain.AppDefaultKeybindings {
  return [
    bind("modelPicker.cycleModel", "alt+m", when),
    bind("modelPicker.cycleModelBackward", "alt+shift+m", when),
    bind("modelPicker.cycleProvider", "alt+p", when),
    bind("modelPicker.cycleProviderBackward", "alt+shift+p", when),
    bind("modelPicker.cycleReasoning", "alt+t", when),
    bind("modelPicker.cycleReasoningBackward", "alt+shift+t", when),
  ];
}

export const DEFAULT_APP_KEYBINDINGS: domain.AppDefaultKeybindings = [
  bind("palette.open", "mod+shift+p", main),
  bind("thread.new", "mod+shift+o", main),
  bind("thread.search", "mod+k", main),
  bind("thread.rename", null, main),
  bind("thread.archive", null, main),
  bind("app.back", "Escape", main),
  bind("settings.open", "mod+,", main),
  bind("sidebar.toggle", "mod+\\", main),
  bind("notifications.open", null, main),
  bind("thread.previous", "control+shift+[", webMain),
  bind("thread.next", "control+shift+]", webMain),
  ...numbered(domain.THREAD_JUMP_APP_COMMAND_IDS, main),
  ...macOnly("pane.focus.left", "mod+control+shift+ArrowLeft", split),
  ...macOnly("pane.focus.right", "mod+control+shift+ArrowRight", split),
  ...macOnly("pane.focus.up", "mod+control+shift+ArrowUp", split),
  ...macOnly("pane.focus.down", "mod+control+shift+ArrowDown", split),
  bind("pane.focus.previous", null, split),
  bind("pane.focus.next", null, split),
  ...numbered(domain.PANE_FOCUS_APP_COMMAND_IDS, split),
  bind("pane.maximize.toggle", "mod+shift+e", split),
  bind("pane.close", "mod+shift+x", split),
  ...macOnly("panel.previousTab", "mod+control+ArrowLeft", main),
  ...macOnly("panel.nextTab", "mod+control+ArrowRight", main),
  ...macOnly("panel.previousNewTabItem", "mod+control+ArrowUp", main),
  ...macOnly("panel.nextNewTabItem", "mod+control+ArrowDown", main),
  bind("panel.newTab", "mod+t", main),
  bind("panel.close", "mod+w", main),
  bind("panel.toggle", "mod+j", main),
  bind("file.quickOpen", "mod+p", main),
  bind("diff.toggle", "mod+d", outsideEditors),
  bind("terminal.open", "mod+shift+Enter", main),
  bind("composer.focus", "mod+shift+c", composer),
  bind("modelPicker.toggle", "mod+shift+m", composer),
  bind("modelPicker.toggle", "mod+shift+m", pickerOpen),
  ...modelPicker(composer),
  ...modelPicker(pickerOpen),
  bind("workspace.openPreferred", "mod+o", main),
  ...domain.QUESTION_SELECT_APP_COMMAND_IDS.map((command, index) =>
    bind(command, String(index + 1), question),
  ),
];
