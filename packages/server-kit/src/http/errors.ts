import { OpError, type OpErrorCode } from "@bb/plugin";
import { RunnerError, type RunnerErrorCode } from "@bb/runner";
import type {
  ApiError as ApiErrorBody,
  HostUnavailableErrorDetails,
} from "@bb/server-contract";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../context.js";

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly body: ApiErrorBody;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    options: { details?: unknown; retryable?: boolean } = {},
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

export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, "forbidden", message);
}

export function threadNotFound(): ApiError {
  return new ApiError(404, "thread_not_found", "Thread not found");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const OP_ERROR_RESPONSES: Record<
  OpErrorCode,
  [status: ContentfulStatusCode, code: string]
> = {
  denied: [403, "denied_by_plugin"],
  forbidden: [403, "forbidden"],
  unimplemented: [501, "unimplemented"],
  invalid_input: [400, "invalid_request"],
  invalid_output: [500, "internal_error"],
  not_found: [404, "not_found"],
  conflict: [409, "conflict"],
  unavailable: [503, "unavailable"],
};

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
  if (error instanceof OpError) {
    const [status, code] = OP_ERROR_RESPONSES[error.code];
    const { plugin, hint } = error;
    const told = {
      ...(plugin === null ? {} : { plugin }),
      ...(hint === null ? {} : { hint }),
    };
    const details = Object.keys(told).length === 0 ? undefined : told;
    return new ApiError(status, error.reason ?? code, error.message, {
      details,
    });
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
