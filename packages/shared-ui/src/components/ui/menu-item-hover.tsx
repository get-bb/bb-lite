import * as React from "react";

const MENU_NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

export const MENU_ITEM_LAST_HOVERED_CLASS =
  "data-[last-hovered]:bg-state-hover data-[last-hovered]:text-foreground";

const MenuHoverContext = React.createContext<{
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}>({ hoveredId: null, setHoveredId: () => {} });

export function MenuHoverProvider({ children }: { children: React.ReactNode }) {
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  return (
    <MenuHoverContext.Provider value={{ hoveredId, setHoveredId }}>
      {children}
    </MenuHoverContext.Provider>
  );
}

export function useMenuItemHover(handlers?: {
  onPointerEnter?: React.PointerEventHandler;
  onKeyDown?: React.KeyboardEventHandler;
}) {
  const id = React.useId();
  const { hoveredId, setHoveredId } = React.useContext(MenuHoverContext);
  const isLastHovered = hoveredId === id;
  return {
    isLastHovered,
    hoverProps: {
      "data-last-hovered": isLastHovered ? ("" as const) : undefined,
      onPointerEnter: (event: React.PointerEvent) => {
        handlers?.onPointerEnter?.(event);
        setHoveredId(id);
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        handlers?.onKeyDown?.(event);
        if (MENU_NAV_KEYS.has(event.key)) setHoveredId(null);
      },
    },
  };
}
