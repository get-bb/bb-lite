import { type RefObject, useLayoutEffect } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import { arrangeByStoredOrder } from "@/lib/stored-order";

export const sidebarFooterOrderAtom = createSyncedPreferenceAtom(
  "sidebar.footerOrder",
);
export const sidebarFooterHiddenAtom = createSyncedPreferenceAtom(
  "sidebar.hiddenFooterItems",
);
export const SIDEBAR_FOOTER_MORE_ID = "sidebar-footer-more";
export const sidebarFooterCapacityAtom = atom<number | null>(null);

export function useMeasureSidebarFooterCapacity(
  rowRef: RefObject<HTMLElement | null>,
  moreRef: RefObject<HTMLElement | null>,
) {
  const setCapacity = useSetAtom(sidebarFooterCapacityAtom);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const more = moreRef.current;
    if (!row || !more) return;
    const measure = () => {
      const width = row.getBoundingClientRect().width;
      const controlWidth = more.getBoundingClientRect().width;
      if (width === 0 || controlWidth === 0) return;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      setCapacity(
        Math.max(0, Math.floor((width + gap) / (controlWidth + gap)) - 1),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(more);
    return () => observer.disconnect();
  }, [rowRef, moreRef, setCapacity]);
}

export type BuiltinFooterId = "settings" | "report-bug";
export type FooterItem = {
  id: BuiltinFooterId;
  key: string;
  label: string;
  icon: string;
};

export function useSidebarFooterPreferences() {
  const order = useAtomValue(sidebarFooterOrderAtom);
  const [hidden, setHidden] = useAtom(sidebarFooterHiddenAtom);
  const capacity = useAtomValue(sidebarFooterCapacityAtom);
  const items: FooterItem[] = [
    {
      id: "settings",
      key: "builtin:settings",
      label: "Settings",
      icon: "Settings",
    },
    {
      id: "report-bug",
      key: "builtin:report-bug",
      label: "Report a bug",
      icon: "Bug",
    },
  ];
  const { ordered } = arrangeByStoredOrder({
    items,
    storedOrder: order,
    getId: (item) => item.key,
  });
  const footer = ordered
    .filter((item) => !hidden.includes(item.key))
    .slice(0, capacity ?? undefined);
  return {
    items: ordered,
    hidden,
    footer,
    hideFromFooter(key: string) {
      setHidden((previous) => [...new Set([...previous, key])]);
    },
    setFooterShown(shown: boolean) {
      setHidden((previous) => {
        const keys = ordered.map((item) => item.key);
        const others = previous.filter((id) => !keys.includes(id));
        return shown ? others : [...others, ...keys];
      });
    },
  };
}
