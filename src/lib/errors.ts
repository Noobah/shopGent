import { z } from "zod";

/**
 * Typed application errors + the single global error mapper.
 *
 * Every API route funnels thrown errors through `handleApiError` (via
 * `withAsyncHandler`) so responses always share one shape:
 *   { error: { code, message } }
 * Unknown errors are logged in full but NEVER leak internals to the client.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "EXTERNAL_SERVICE_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  /** Message that is safe to return to the client. */
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.expose = options.expose ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request", options: { cause?: unknown } = {}) {
    super(400, "VALIDATION_ERROR", message, options);
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication required", options: { cause?: unknown } = {}) {
    super(401, "UNAUTHORIZED", message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", options: { cause?: unknown } = {}) {
    super(403, "FORBIDDEN", message, options);
  }
}

/**
 * NOTE: per the build prompt, cross-user resource access returns 404 (NOT 403)
 * so we don't leak the existence of other users' resources. Use this for that.
 */
export class NotFoundError extends AppError {
  constructor(message = "Not found", options: { cause?: unknown } = {}) {
    super(404, "NOT_FOUND", message, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", options: { cause?: unknown } = {}) {
    super(409, "CONFLICT", message, options);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", options: { cause?: unknown } = {}) {
    super(429, "RATE_LIMITED", message, options);
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    statusCode: 502 | 504 = 502,
    message = "Upstream service error",
    options: { cause?: unknown } = {},
  ) {
    super(statusCode, "EXTERNAL_SERVICE_ERROR", message, options);
  }
}

/** The standardized error body returned to clients. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Minimal structural check for a ZodError (avoids instanceof fragility). */
function isZodError(err: unknown): err is z.ZodError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Map any thrown value to a client-safe `Response`.
 *
 * - AppError         -> its own status/code/exposed message
 * - ZodError         -> 400 VALIDATION_ERROR with field summary
 * - unknown/other    -> logged in full; client gets a generic 500
 */
export function handleApiError(err: unknown): Response {
  let statusCode: number;
  let code: ErrorCode;
  let message: string;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    // Never expose internal messages that were marked non-exposable.
    message = err.expose ? err.message : "Internal server error";
    if (!err.expose) {
      logInternal(err);
    }
  } else if (isZodError(err)) {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = formatZodIssues(err);
  } else {
    statusCode = 500;
    code = "INTERNAL_ERROR";
    message = "Internal server error";
    logInternal(err);
  }

  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status: statusCode });
}

function formatZodIssues(err: z.ZodError): string {
  const parts = err.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
  return parts.length > 0 ? parts.join("; ") : "Invalid request";
}

/**
 * Log an internal/unexpected error. Swap the console for a structured logger
 * once `lib/logger` is wired in later phases; kept dependency-free here so
 * Phase 0 stands alone.
 */
function logInternal(err: unknown): void {
  if (err instanceof Error) {
    console.error("[api-error]", {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause,
    });
  } else {
    console.error("[api-error]", { value: err });
  }
}
