import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const collapsedProjectIdsAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedProjects",
);
