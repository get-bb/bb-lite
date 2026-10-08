import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { parseEnvironmentValue } from "../components/pickers/environment-picker-value";
import { createTabScopedStorage } from "./browser-storage";

const placementSchema = z.object({
  sectionId: z
    .string()
    .refine((sectionId) => sectionId.trim().length > 0)
    .nullable(),
  pinned: z.boolean(),
});
type ThreadCreationPlacement = z.infer<typeof placementSchema>;

export const DEFAULT_THREAD_CREATION_PLACEMENT: ThreadCreationPlacement = {
  sectionId: null,
  pinned: false,
};

export function readThreadCreationPlacement(
  state: unknown,
): ThreadCreationPlacement | null {
  const parsed = z.object({ placement: placementSchema }).safeParse(state);
  return parsed.success ? parsed.data.placement : null;
}

const rootComposeProjectIdAtom = atomWithStorage<string>(
  "bb.root-compose.project-id",
  PERSONAL_PROJECT_ID,
  createTabScopedStorage<string>(
    {
      parse: (storedValue, initialValue) => storedValue || initialValue,
      serialize: (value) => value,
    },
    { persistInitialValue: true },
  ),
  { getOnInit: true },
);

const rootComposeReuseEnvironmentAtom = atomWithStorage<string | null>(
  "bb.root-compose.reuse-environment",
  null,
  createTabScopedStorage<string | null>({
    parse: (storedValue) =>
      storedValue !== null &&
      parseEnvironmentValue(storedValue)?.type === "reuse"
        ? storedValue
        : null,
    serialize: (value) => value ?? "",
  }),
  { getOnInit: true },
);

const rootComposeStoredPlacementAtom = atomWithStorage<ThreadCreationPlacement>(
  "bb.root-compose.placement",
  DEFAULT_THREAD_CREATION_PLACEMENT,
  createTabScopedStorage<ThreadCreationPlacement>({
    parse: (storedValue, initialValue) => {
      try {
        const placement: unknown = JSON.parse(storedValue ?? "");
        return readThreadCreationPlacement({ placement }) ?? initialValue;
      } catch {
        return initialValue;
      }
    },
    serialize: JSON.stringify,
  }),
  { getOnInit: true },
);

const rootComposePlacementAtom = atom(
  (get) => get(rootComposeStoredPlacementAtom),
  (get, set, next: ThreadCreationPlacement) => {
    const current = get(rootComposeStoredPlacementAtom);
    if (
      current.sectionId !== next.sectionId ||
      current.pinned !== next.pinned
    ) {
      set(rootComposeStoredPlacementAtom, next);
    }
  },
);

export function useRootComposePlacement() {
  return useAtom(rootComposePlacementAtom);
}

export function useRootComposeProjectId() {
  return useAtom(rootComposeProjectIdAtom);
}

export function useSetRootComposeProjectId() {
  return useSetAtom(rootComposeProjectIdAtom);
}

export function useRootComposeReuseEnvironment() {
  return useAtom(rootComposeReuseEnvironmentAtom);
}
