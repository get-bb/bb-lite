import type { MouseEvent as ReactMouseEvent } from "react";

export function openUrlInExternalBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openHttpUrlInExternalBrowser(url: string): boolean {
  if (!/^https?:\/\//iu.test(url)) return false;
  openUrlInExternalBrowser(url);
  return true;
}

const APP_NAVIGATION_HOST = {
  openUrl: ({ url }: { url: string }) => openHttpUrlInExternalBrowser(url),
};

export function useAppNavigationHost() {
  return APP_NAVIGATION_HOST;
}

export function useUrlAnchorClickHandler(url: string | undefined) {
  return (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      url === undefined ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (openHttpUrlInExternalBrowser(url)) event.preventDefault();
  };
}
