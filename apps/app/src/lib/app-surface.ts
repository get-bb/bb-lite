const APP_SURFACE_HEADER_NAME = "x-bb-app-surface";

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, "web");
  return {
    ...init,
    headers,
  };
}

export function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  return fetch(input, appSurfaceRequestInit(init));
}
