import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface Layer {
  modal: boolean;
  order: number;
  hidden: Element[];
}

interface CloseDetails {
  reason: string;
  event: Event;
  cancel: () => void;
  allowPropagation: () => void;
}

const layers: Layer[] = [];
let layerCount = 0;
let pressLayers: Layer[] = [];
const consumedEscapes = new WeakSet<Event>();
const topModalIndex = () =>
  layers.map((layer) => layer.modal).lastIndexOf(true);

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      pressLayers = layers.slice(Math.max(topModalIndex(), 0));
    },
    { capture: true },
  );
}

export function consumeEscape(event: Event) {
  consumedEscapes.add(event);
  event.preventDefault();
}

export function useLayer(
  open: boolean,
  modal: boolean,
  popupId: string,
  onAuxPressOutside?: () => void,
) {
  const actionsRef = useRef<{ unmount: () => void; close: () => void }>(null);
  const entry = useRef<Layer | null>(null);
  const press = useRef({ inside: false, outside: false, right: false });
  const wasOpen = useRef(false);
  const dismiss = useEffectEvent(() => onAuxPressOutside?.());
  useLayoutEffect(() => {
    if (wasOpen.current && !open && !document.getElementById(popupId)) {
      actionsRef.current?.unmount();
    }
    wasOpen.current = open;
    if (!open) return;
    const layer: Layer = { modal, order: ++layerCount, hidden: [] };
    entry.current = layer;
    layers.push(layer);
    press.current = { inside: false, outside: false, right: false };
    const onPointerDown = (event: PointerEvent) => {
      const state = press.current;
      if (!state.inside && event.button !== 0 && pressLayers.includes(layer)) {
        state.outside = true;
        state.right = event.button === 2;
        dismiss();
      }
      state.inside = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener("pointerdown", onPointerDown);
      unhide(layer);
    };
  }, [open, modal, popupId]);
  const [layer] = useState(() => ({
    actionsRef,
    press,
    markPressInside: () => {
      press.current.inside = true;
    },
    hideOthers: (portal: Element | null) => {
      const layer = entry.current;
      if (portal === null || layer === null) return;
      const hidden = hideOthers(portal);
      return () => {
        layer.hidden.push(...hidden);
        if (!layers.includes(layer)) unhide(layer);
      };
    },
    isTopModal: () => layers[topModalIndex()] === entry.current,
    ignores: (details: CloseDetails) => {
      const ignored =
        consumedEscapes.has(details.event) ||
        (details.reason === "escape-key" && layers.at(-1) !== entry.current) ||
        (details.reason === "outside-press" &&
          entry.current !== null &&
          !pressLayers.includes(entry.current));
      if (ignored) {
        details.cancel();
        details.allowPropagation();
      }
      return ignored;
    },
  }));
  return layer;
}

export type OverlayLayer = ReturnType<typeof useLayer>;

let outsidePointerLocks = 0;
let bodyPointerEvents = "";

function lockOutsidePointer() {
  if (outsidePointerLocks++ === 0) {
    bodyPointerEvents = document.body.style.pointerEvents;
    document.body.style.pointerEvents = "none";
  }
  return () => {
    if (--outsidePointerLocks === 0) {
      document.body.style.pointerEvents = bodyPointerEvents;
    }
  };
}

function trapFocus(portal: Element | null, isActive: () => boolean) {
  const inside = (target: EventTarget | null) =>
    target instanceof Node && portal !== null && portal.contains(target);
  const active = document.activeElement;
  let last = active instanceof HTMLElement && inside(active) ? active : null;
  const restore = () => {
    if (!isActive()) return;
    const previous = document.activeElement;
    last?.focus({ preventScroll: true });
    if (last !== previous && last instanceof HTMLInputElement) last.select();
  };
  const onFocusIn = ({ target }: FocusEvent) => {
    if (!inside(target)) restore();
    else if (
      target instanceof HTMLElement &&
      !target.hasAttribute("data-base-ui-focus-guard")
    ) {
      last = target;
    }
  };
  const onFocusOut = ({ relatedTarget }: FocusEvent) => {
    if (relatedTarget !== null && !inside(relatedTarget)) restore();
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}

function unhide(layer: Layer) {
  const heir = layers.find((item) => item.modal && item.order > layer.order);
  if (heir) heir.hidden.push(...layer.hidden);
  else
    for (const element of layer.hidden) element.removeAttribute("aria-hidden");
  layer.hidden = [];
}

function hideOthers(portal: Element) {
  const keep = new Set<Node>();
  const stop = [portal, ...document.querySelectorAll("[aria-live], script")];
  for (const element of stop) {
    for (let node: Node | null = element; node; node = node.parentNode) {
      keep.add(node);
    }
  }
  const hidden: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (stop.includes(child)) continue;
      if (keep.has(child)) walk(child);
      else if (child.getAttribute("aria-hidden") !== "true") {
        child.setAttribute("aria-hidden", "true");
        hidden.push(child);
      }
    }
  };
  walk(document.body);
  return hidden;
}

export function useModalLayer(
  popupId: string | undefined,
  open: boolean,
  kind: "popover" | "menu" | "dialog",
  layer: OverlayLayer | null,
) {
  const portal = () =>
    document.getElementById(popupId ?? "")?.closest("[data-base-ui-portal]") ??
    null;
  useEffect(() => {
    if (kind === "popover") return lockOutsidePointer();
    if (kind === "menu") return layer?.hideOthers(portal());
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const untrap = trapFocus(portal(), () => layer?.isTopModal() ?? true);
    const unlock = kind === "popover" ? undefined : lockOutsidePointer();
    return () => {
      untrap();
      unlock?.();
    };
  }, [open]);
}
