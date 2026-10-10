import {
  QUESTION_SELECT_APP_COMMAND_IDS,
  PANE_FOCUS_APP_COMMAND_IDS,
  THREAD_JUMP_APP_COMMAND_IDS,
  type AppCommandId,
} from "@bb/domain";

interface AppCommandMetadata {
  command: AppCommandId;
  description: string;
  label: string;
  paletteVisible: boolean;
}

interface AppCommandGroup {
  commands: readonly AppCommandMetadata[];
  label: string;
}

type CommandTexts = Partial<Record<AppCommandId, string>>;

const PALETTE_HIDDEN_COMMAND = /^palette\.open$|^modelPicker\.cycle|\.\d$/u;

function group(label: string, texts: CommandTexts): AppCommandGroup {
  const commands = Object.entries(texts).map(([id, text]) => {
    const separator = text.indexOf(": ");
    return {
      command: id as AppCommandId,
      label: text.slice(0, separator),
      description: text.slice(separator + 2),
      paletteVisible: !PALETTE_HIDDEN_COMMAND.test(id),
    };
  });
  return { label, commands };
}

function numbered(
  ids: readonly AppCommandId[],
  text: (position: number) => string,
): CommandTexts {
  return Object.fromEntries(ids.map((id, index) => [id, text(index + 1)]));
}

export const APP_COMMAND_GROUPS: readonly AppCommandGroup[] = [
  group("Threads", {
    "thread.new": "New thread: Start a thread in the active project.",
    "thread.search": "Search threads: Search threads in the quick palette.",
    "thread.rename": "Rename thread: Rename the focused thread.",
    "thread.archive": "Archive thread: Archive the focused thread.",
    "thread.previous":
      "Previous thread: Open the previous visible sidebar thread.",
    "thread.next": "Next thread: Open the next visible sidebar thread.",
    ...numbered(
      THREAD_JUMP_APP_COMMAND_IDS,
      (n) => `Open thread ${n}: Open visible sidebar thread ${n}.`,
    ),
  }),
  group("Window and layout", {
    "palette.open":
      "Open quick palette: Search and run bb commands from the keyboard.",
    "app.back": "Back to app: Return from Settings to the app.",
    "settings.open": "Open settings: Open bb settings.",
    "sidebar.toggle": "Toggle sidebar: Show or hide the app sidebar.",
    "panel.previousTab":
      "Previous panel tab: Select the previous visible right-panel tab, wrapping across panel splits.",
    "panel.nextTab":
      "Next panel tab: Select the next visible right-panel tab, wrapping across panel splits.",
    "panel.previousNewTabItem":
      "Previous New tab item: Focus the previous search, action, or recent item on the selected New tab page.",
    "panel.nextNewTabItem":
      "Next New tab item: Focus the next search, action, or recent item on the selected New tab page.",
    "panel.newTab": "New panel tab: Open a tab in the secondary panel.",
    "panel.close": "Close panel tab: Close the active panel tab or terminal.",
    "panel.toggle": "Toggle panel: Show or hide the secondary panel.",
    "pane.focus.left":
      "Focus chat pane left: Focus the chat pane to the left of the current pane.",
    "pane.focus.right":
      "Focus chat pane right: Focus the chat pane to the right of the current pane.",
    "pane.focus.up":
      "Focus chat pane up: Focus the chat pane above the current pane.",
    "pane.focus.down":
      "Focus chat pane down: Focus the chat pane below the current pane.",
    "pane.focus.previous":
      "Focus previous chat pane: Focus the previous chat pane in reading order.",
    "pane.focus.next":
      "Focus next chat pane: Focus the next chat pane in reading order.",
    ...numbered(
      PANE_FOCUS_APP_COMMAND_IDS,
      (n) => `Focus chat pane ${n}: Focus chat pane ${n} in reading order.`,
    ),
    "pane.maximize.toggle":
      "Toggle focused chat pane size: Maximize the focused chat pane or restore its split layout.",
    "pane.close":
      "Close focused chat pane: Close the focused chat pane when more than one is open.",
  }),
  group("Workspace", {
    "file.quickOpen":
      "Quick open file: Search workspace files in a new panel tab.",
    "diff.toggle": "Toggle diff: Open or close the environment diff.",
    "terminal.open": "Open terminal: Open a terminal in the secondary panel.",
    "workspace.openPreferred":
      "Open in preferred app: Open the workspace in the preferred editor or terminal.",
  }),
  group("Composer and models", {
    "composer.focus":
      "Focus composer: Focus the active composer's input and move the caret to the end.",
    "modelPicker.toggle":
      "Toggle model picker: Open or close the focused composer's model picker.",
    "modelPicker.cycleModel":
      "Cycle model forward: Select the next model of the composer's provider, wrapping at the end.",
    "modelPicker.cycleModelBackward":
      "Cycle model backward: Select the previous model of the composer's provider, wrapping at the beginning.",
    "modelPicker.cycleProvider":
      "Cycle provider forward: Select the next provider for the composer, wrapping at the end.",
    "modelPicker.cycleProviderBackward":
      "Cycle provider backward: Select the previous provider for the composer, wrapping at the beginning.",
    "modelPicker.cycleReasoning":
      "Cycle reasoning effort forward: Select the next higher supported reasoning effort, wrapping after the highest.",
    "modelPicker.cycleReasoningBackward":
      "Cycle reasoning effort backward: Select the next lower supported reasoning effort, wrapping before the lowest.",
  }),
  group(
    "Questions",
    numbered(
      QUESTION_SELECT_APP_COMMAND_IDS,
      (n) =>
        `Choose answer ${n}: Choose visible answer ${n} when bb asks a question.`,
    ),
  ),
];
