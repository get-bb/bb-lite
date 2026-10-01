import { RunnerError, type RunnerErrorCode } from "@bb/runner";
import type {
  ApiError as ApiErrorBody,
  HostUnavailableErrorDetails,
} from "@bb/server-contract";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../context.js";

export interface ApiErrorOptions {
  details?: unknown;
  retryable?: boolean;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly body: ApiErrorBody;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = { code, message, ...options };
  }
}

export function notFound(message = "Not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

export function invalidRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

export function hostUnavailable(): ApiError {
  const details: HostUnavailableErrorDetails = {
    reason: "disconnected",
    hostStatus: "disconnected",
    suspendedAt: null,
    destroyedAt: null,
  };
  return new ApiError(502, "host_unavailable", "Host is not connected", {
    details,
    retryable: false,
  });
}

function runnerErrorStatus(code: RunnerErrorCode): ContentfulStatusCode {
  if (code.endsWith("_not_found")) return 404;
  if (code === "unavailable") return 503;
  return code === "failed" ? 502 : 409;
}

export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof RunnerError) {
    return new ApiError(
      runnerErrorStatus(error.code),
      error.code,
      error.message,
      { retryable: error.retryable },
    );
  }
  if (error instanceof HTTPException && error.status < 500) {
    return new ApiError(error.status, "invalid_request", error.message);
  }
  return null;
}

export function errorResponse(
  error: unknown,
  log: Logger,
  request: { method: string; path: string },
): Response {
  const known = toApiError(error);
  if (known === null) {
    const { method, path } = request;
    log.error("Request failed", { err: error, method, path });
  }
  const failure =
    known ?? new ApiError(500, "internal_error", "Internal server error");
  return Response.json(failure.body, { status: failure.status });
}
