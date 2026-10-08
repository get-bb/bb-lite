export function buildBrowserWebSocketUrl(path: string): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${path}`;
}
