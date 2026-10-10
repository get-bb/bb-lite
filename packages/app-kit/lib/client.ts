import { createOpClient } from "@bb/plugin/app";
import {
  uploadedPromptAttachmentSchema,
  type UploadedPromptAttachment,
} from "@bb/server-contract";
import type {
  AcceptInviteRequest,
  AuthSessionResponse,
  InvitePreviewResponse,
  LoginRequest,
} from "@bb/server-contract";

type FetchInput = Parameters<typeof fetch>[0];

let unauthenticatedHandler: (() => void) | null = null;

export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  unauthenticatedHandler = handler;
}

function requiresSession(input: FetchInput): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const { pathname } = new URL(url, "http://localhost");
  return (
    pathname.startsWith("/api/v1/") && !pathname.startsWith("/api/v1/auth/")
  );
}

export async function sessionAwareFetch(
  input: FetchInput,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && requiresSession(input)) {
    unauthenticatedHandler?.();
  }
  return response;
}

export const client = createOpClient({
  baseUrl:
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  fetch: sessionAwareFetch,
  door: "app",
});

async function read<Body>(path: string, init?: RequestInit): Promise<Body> {
  const response = await client.request(`/api/v1${path}`, init);
  return (await response.json()) as Body;
}

function post(body: unknown): RequestInit {
  const headers = { "content-type": "application/json" };
  return { method: "POST", headers, body: JSON.stringify(body) };
}

export const auth = {
  session: (signal?: AbortSignal) =>
    read<AuthSessionResponse>("/auth/session", signal && { signal }),
  login: (credentials: LoginRequest) =>
    read<AuthSessionResponse>("/auth/login", post(credentials)),
  logout: () => read<{ ok: true }>("/auth/logout", { method: "POST" }),
  invite: (token: string) =>
    read<InvitePreviewResponse>(`/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: ({ token, ...body }: AcceptInviteRequest & { token: string }) =>
    read<AuthSessionResponse>(
      `/auth/invites/${encodeURIComponent(token)}/accept`,
      post(body),
    ),
};

export async function uploadAttachment(
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  if (file.name.trim() === "") {
    throw new Error("Project attachment filename must not be empty");
  }
  const body = new FormData();
  body.set("file", file, file.name);
  const path = `/projects/${encodeURIComponent(projectId)}/attachments`;
  return uploadedPromptAttachmentSchema.parse(
    await read(path, { method: "POST", body }),
  );
}
