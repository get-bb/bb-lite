import type { ExtensionKind } from "@bb/domain";

export const THREAD_PROVIDER_COMMANDS_STATE_KIND =
  "bb/provider-commands" satisfies ExtensionKind;
export const THREAD_SESSION_OPTIONS_STATE_KIND =
  "bb/session-options" satisfies ExtensionKind;

export type ThreadProviderCommand = {
  name: string;
  description: string;
  inputHint?: string;
};

export type ThreadProviderCommandsState = {
  commands: ThreadProviderCommand[];
};

export type ThreadSessionOptionValue = {
  id: string;
  label: string;
  description?: string;
  group?: string;
};

type ThreadSessionOptionBase = {
  id: string;
  label: string;
  description?: string;
  category?: string;
};

export type ThreadSessionOption =
  | (ThreadSessionOptionBase & {
      type: "select";
      value: string;
      values: ThreadSessionOptionValue[];
    })
  | (ThreadSessionOptionBase & { type: "boolean"; value: boolean });

export type ThreadSessionOptionsState = {
  options: ThreadSessionOption[];
};

export type SessionOptionSelections = Record<string, string | boolean>;
import type {
  AcpAvailableCommand,
  AcpBooleanConfigOption,
  AcpConfigOption,
  AcpSelectConfigOption,
} from "./session-types.js";

const MAX_COMMANDS = 500;
const MAX_OPTIONS = 64;
const MAX_OPTION_VALUES = 1000;

export function toThreadProviderCommandsState(
  commands: readonly AcpAvailableCommand[],
): ThreadProviderCommandsState {
  return {
    commands: commands
      .filter((command) => command.name.trim() !== "")
      .slice(0, MAX_COMMANDS)
      .map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.inputHint ? { inputHint: command.inputHint } : {}),
      })),
  };
}

function selectValues(
  option: AcpSelectConfigOption,
): ThreadSessionOptionValue[] {
  const groupNameByValue = new Map<string, string>();
  for (const group of option.groups) {
    for (const value of group.options) {
      groupNameByValue.set(value.value, group.name);
    }
  }
  return option.values
    .filter((value) => value.value !== "")
    .slice(0, MAX_OPTION_VALUES)
    .map((value) => {
      const group = groupNameByValue.get(value.value);
      return {
        id: value.value,
        label: value.name.trim() === "" ? value.value : value.name,
        ...(value.description ? { description: value.description } : {}),
        ...(group ? { group } : {}),
      };
    });
}

const BRIDGE_MANAGED_OPTION_CATEGORIES = new Set(["model", "thought_level"]);
const BRIDGE_MANAGED_SERVICE_TIER_OPTION_ID = "fast";

export function isUserSelectableSessionOption(
  option: AcpConfigOption,
): option is AcpSelectConfigOption | AcpBooleanConfigOption {
  return (
    option.type !== "unsupported" &&
    !(
      option.category !== undefined &&
      BRIDGE_MANAGED_OPTION_CATEGORIES.has(option.category)
    ) &&
    !(
      option.type === "select" &&
      option.id === BRIDGE_MANAGED_SERVICE_TIER_OPTION_ID
    )
  );
}

export function toThreadSessionOptionsState(
  options: readonly AcpConfigOption[],
): ThreadSessionOptionsState {
  const sessionOptions: ThreadSessionOption[] = [];
  for (const option of options) {
    if (!isUserSelectableSessionOption(option)) {
      continue;
    }
    const base = {
      id: option.id,
      label: option.name.trim() === "" ? option.id : option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
    };
    sessionOptions.push(
      option.type === "boolean"
        ? { ...base, type: "boolean", value: option.currentValue }
        : {
            ...base,
            type: "select",
            value: option.currentValue,
            values: selectValues(option),
          },
    );
  }
  return { options: sessionOptions.slice(0, MAX_OPTIONS) };
}
