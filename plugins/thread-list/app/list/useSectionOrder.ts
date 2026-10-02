import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import {
  normalizeSidebarSectionOrder,
  reorderStoredOrder,
  type SidebarSectionId,
} from "@bb/client-core";
import { sidebarManualSectionOrderAtom } from "../preferences.js";

export function useSectionOrder(
  entitySectionIds: readonly SidebarSectionId[],
  showPinnedSection: boolean,
) {
  const [storedOrder, setStoredOrder] = useAtom(sidebarManualSectionOrderAtom);
  const order = useMemo(
    () =>
      normalizeSidebarSectionOrder({
        storedOrder,
        entitySectionIds,
        legacyEntityAnchor: "sections",
        hasPinnedSection: true,
      }).filter((id) => id !== "pinned" || showPinnedSection),
    [entitySectionIds, showPinnedSection, storedOrder],
  );
  const onOrderChange = useCallback(
    (nextOrder: SidebarSectionId[]) => {
      const nextIds = new Set(nextOrder);
      setStoredOrder((current) => {
        const fullOrder = normalizeSidebarSectionOrder({
          storedOrder: current,
          entitySectionIds: [
            ...entitySectionIds,
            ...current.filter((id): id is SidebarSectionId =>
              id.startsWith("section:"),
            ),
          ],
          legacyEntityAnchor: "sections",
          hasPinnedSection: true,
        });
        return (
          reorderStoredOrder({
            order: fullOrder,
            visibleIds: fullOrder.filter((id) => nextIds.has(id)),
            nextVisibleIds: nextOrder,
          }) ?? current
        );
      });
    },
    [entitySectionIds, setStoredOrder],
  );
  return { onOrderChange, order };
}
