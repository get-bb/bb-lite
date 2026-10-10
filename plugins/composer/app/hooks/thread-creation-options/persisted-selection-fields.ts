import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import {
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  sessionOptionSelectionsSchema,
  type SessionOptionSelections,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type { z } from "zod";
import { createTabScopedStorage } from "@bb/app-kit/lib/browser-storage";
import { getProjectScopedStorageKey } from "../../lib/project-scoped-storage";

function storedChoice<T extends string>(key: string, schema?: z.ZodType<T>) {
  return atomWithStorage<T | "">(
    key,
    "",
    createTabScopedStorage<T | "">(
      {
        parse: (value, initialValue) => {
          if (value === null) return initialValue;
          if (schema === undefined) return value as T;
          const parsed = schema.safeParse(value);
          return parsed.success ? parsed.data : initialValue;
        },
        serialize: (value) => value,
      },
      { persistInitialValue: true },
    ),
    { getOnInit: true },
  );
}

function providerChoice<T extends string>(
  storageKey: string,
  providerId: string,
  schema?: z.ZodType<T>,
): ReturnType<typeof storedChoice<T>> {
  return providerId.length === 0
    ? (atom<T | "">("") as unknown as ReturnType<typeof storedChoice<T>>)
    : storedChoice(
        `${storageKey}-${encodeURIComponent(providerId.trim())}-1`,
        schema,
      );
}

export const storedProviderIdAtom = storedChoice<string>(
  "bb.promptbox.provider",
);
export const storedModelAtomFamily = atomFamily((providerId: string) =>
  providerChoice<string>("bb.promptbox.model", providerId),
);
export const storedReasoningLevelAtomFamily = atomFamily((providerId: string) =>
  providerChoice<ReasoningLevel>(
    "bb.promptbox.reasoning",
    providerId,
    reasoningLevelSchema,
  ),
);
const NO_SESSION_OPTION_SELECTIONS: SessionOptionSelections = {};

export function parseStoredSessionOptionSelections(
  value: string | null,
): SessionOptionSelections {
  if (value === null || value.length === 0) {
    return NO_SESSION_OPTION_SELECTIONS;
  }
  try {
    const parsed = sessionOptionSelectionsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : NO_SESSION_OPTION_SELECTIONS;
  } catch {
    return NO_SESSION_OPTION_SELECTIONS;
  }
}

export function serializeSessionOptionSelections(
  selections: SessionOptionSelections,
): string {
  return Object.keys(selections).length === 0 ? "" : JSON.stringify(selections);
}

export const storedSessionOptionsAtomFamily = atomFamily(
  (providerId: string) =>
    providerId.length === 0
      ? atom<SessionOptionSelections>(NO_SESSION_OPTION_SELECTIONS)
      : atomWithStorage<SessionOptionSelections>(
          `bb.promptbox.session-options-${encodeURIComponent(providerId.trim())}-1`,
          NO_SESSION_OPTION_SELECTIONS,
          createTabScopedStorage<SessionOptionSelections>(
            {
              parse: (value) => parseStoredSessionOptionSelections(value),
              serialize: serializeSessionOptionSelections,
            },
            { persistInitialValue: false },
          ),
          { getOnInit: true },
        ),
);
export const storedServiceTierAtom = storedChoice<ServiceTier>(
  "bb.promptbox.service-tier",
  serviceTierSchema,
);
export const storedPermissionModeAtom = storedChoice<PermissionMode>(
  "bb.promptbox.permission-mode",
  permissionModeSchema,
);
export const storedEnvironmentAtomFamily = atomFamily((projectId: string) =>
  storedChoice<string>(
    getProjectScopedStorageKey("bb.promptbox.environment", projectId),
  ),
);
export const storedMachineAtomFamily = atomFamily((projectId: string) =>
  storedChoice<string>(
    getProjectScopedStorageKey("bb.promptbox.machine", projectId),
  ),
);
