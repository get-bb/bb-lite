import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";

type UrlAnchorClickHandler = (
  event: ReactMouseEvent<HTMLAnchorElement>,
) => void;

const HTTP_URL_SCHEME_PATTERN = /^https?:\/\//iu;

export function openUrlInExternalBrowser(url: string): void {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function openHttpUrlInExternalBrowser(url: string): boolean {
  if (!HTTP_URL_SCHEME_PATTERN.test(url)) {
    return false;
  }
  openUrlInExternalBrowser(url);
  return true;
}

const URL_NAVIGATION_CAPABILITIES = {
  openUrl: ({ url }: { url: string }) => openHttpUrlInExternalBrowser(url),
};

export function AppNavigationUrlHost({ children }: { children: ReactNode }) {
  return (
    <AppNavigationHostProvider capabilities={URL_NAVIGATION_CAPABILITIES}>
      {children}
    </AppNavigationHostProvider>
  );
}

export function useUrlAnchorClickHandler(
  url: string | undefined,
): UrlAnchorClickHandler {
  return useCallback(
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || url === undefined) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (openHttpUrlInExternalBrowser(url)) {
        event.preventDefault();
      }
    },
    [url],
  );
}
