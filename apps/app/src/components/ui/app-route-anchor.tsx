import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useTransition,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, type NavigateOptions } from "react-router-dom";
import { useStore } from "jotai";
import { resolveRouteHref } from "@/lib/route-paths";
import { openPaneContentInSplit } from "@/lib/split-layout/atoms";
import { paneContentForPathname } from "@/views/thread-detail/splitThreadNavigation";

type RouteNavigate = (
  path: string,
  options?: { replace?: boolean; state?: NavigateOptions["state"] },
) => void;

interface RouteNavigation {
  navigate: RouteNavigate;
  navigateImmediately: RouteNavigate;
  openInSplit: (path: string) => boolean;
}

const RouteNavigationContext = createContext<RouteNavigation | null>(null);

const RouteNavigationPendingContext = createContext(false);

export function useIsRouteNavigationPending(): boolean {
  return useContext(RouteNavigationPendingContext);
}

export function useRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.navigate ?? navigateWithoutProvider
  );
}

export function useImmediateRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.navigateImmediately ??
    navigateWithoutProvider
  );
}

function navigateWithoutProvider(path: string): void {
  throw new Error(
    `route navigation: no <RouteNavigationProvider> above the caller (navigating to "${path}")`,
  );
}

function shouldHandleRouteAnchorClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  const target = event.currentTarget.getAttribute("target");
  return target === null || target === "" || target === "_self";
}

export function RouteNavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const store = useStore();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const [isNavigationPending, startNavigationTransition] = useTransition();
  const navigateImmediately = useCallback<RouteNavigate>((path, options) => {
    if (options === undefined) {
      navigateRef.current(path);
      return;
    }
    navigateRef.current(path, options);
  }, []);
  const navigateRoute = useCallback<RouteNavigate>(
    (path, options) => {
      startNavigationTransition(() => {
        navigateImmediately(path, options);
      });
    },
    [navigateImmediately, startNavigationTransition],
  );
  const openInSplit = useCallback<RouteNavigation["openInSplit"]>(
    (path) => {
      const content = paneContentForPathname(path.split(/[?#]/)[0] ?? path);
      if (content === null) return false;
      openPaneContentInSplit({
        store,
        navigate: navigateRoute,
        content,
        route: path,
        enabled: true,
      });
      return true;
    },
    [navigateRoute, store],
  );
  const value = useMemo<RouteNavigation>(
    () => ({ navigate: navigateRoute, navigateImmediately, openInSplit }),
    [navigateImmediately, navigateRoute, openInSplit],
  );
  return (
    <RouteNavigationContext.Provider value={value}>
      <RouteNavigationPendingContext.Provider value={isNavigationPending}>
        {children}
      </RouteNavigationPendingContext.Provider>
    </RouteNavigationContext.Provider>
  );
}

function anchorInScope(root: HTMLElement, anchor: HTMLAnchorElement): boolean {
  if (root.contains(anchor)) return true;
  const pluginId = root.getAttribute("data-bb-plugin");
  const overlay = anchor.closest("[data-bb-portaled-overlay]");
  return (
    pluginId !== null && overlay?.getAttribute("data-bb-plugin") === pluginId
  );
}

export function useRouteAnchorDelegate(): (
  event: ReactMouseEvent<HTMLElement>,
) => void {
  const navigation = useContext(RouteNavigationContext);
  return useCallback(
    (event) => {
      if (navigation === null || event.defaultPrevented) return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (anchor === null || !anchorInScope(event.currentTarget, anchor)) {
        return;
      }
      const target = anchor.getAttribute("target");
      if (target !== null && target !== "" && target !== "_self") return;
      if (event.button !== 0 || event.altKey || event.shiftKey) return;
      const route = resolveRouteHref({
        currentOrigin: window.location.origin,
        href: anchor.getAttribute("href") ?? "",
      });
      if (route === null) return;
      if (event.metaKey || event.ctrlKey) {
        if (navigation.openInSplit(route.path)) event.preventDefault();
        return;
      }
      event.preventDefault();
      navigation.navigate(route.path);
    },
    [navigation],
  );
}

export function RouteAnchor({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: Omit<ComponentPropsWithoutRef<"a">, "href"> & { href: string | undefined }) {
  const navigation = useContext(RouteNavigationContext);
  const route = useMemo(
    () =>
      href === undefined
        ? null
        : resolveRouteHref({ currentOrigin: window.location.origin, href }),
    [href],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);
      if (
        route === null ||
        navigation === null ||
        !shouldHandleRouteAnchorClick(event)
      ) {
        return;
      }

      event.preventDefault();
      navigation.navigate(route.path);
    },
    [navigation, onClick, route],
  );

  return (
    <a
      {...anchorProps}
      href={href}
      rel={route === null ? rel : undefined}
      target={route === null ? target : undefined}
      onClick={handleClick}
    />
  );
}
