/**
 * Minimal structured logger with redaction.
 *
 * Phase 0 needs just enough to: emit structured (JSON) logs and redact PII
 * (emails) and secrets (keys/tokens/connection strings) before they hit the
 * console or any future log sink. Kept dependency-free on purpose — swap the
 * console transport for a real sink later without changing call sites.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Keys/tokens/passwords/URIs that must never be logged verbatim.
const SECRET_KEY_RE =
  /(password|passwd|secret|token|apikey|api_key|authorization|cookie|session|(?:mongodb|postgres|redis)(?:\+srv)?:\/\/)/i;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Recursively redact emails and secret-looking values. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limited]";

  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(value)) return "[redacted]";
    return value.replace(EMAIL_RE, "[redacted-email]");
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogContext {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    ...(context ? (redact(context) as LogContext) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit("debug", message, context),
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
};
