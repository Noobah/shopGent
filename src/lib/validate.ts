import type { NextRequest } from "next/server";
import { z } from "zod";
import { ValidationError } from "./errors";

/**
 * Zod request-validation helpers used by EVERY Route Handler.
 *
 * On failure they throw `ValidationError` (400), which `withAsyncHandler`
 * converts into the standardized `{ error: { code, message } }` body.
 */

/** Parse and validate a JSON request body against a Zod schema. */
export async function parseBody<S extends z.ZodType>(
  schema: S,
  req: NextRequest,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(formatIssues(result.error));
  }
  return result.data;
}

/** Validate an already-parsed object (e.g. Server Action payload). */
export function parseObject<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(formatIssues(result.error));
  }
  return result.data;
}

/** Parse and validate URL query params against a Zod schema. */
export function parseQuery<S extends z.ZodType>(schema: S, req: NextRequest): z.infer<S> {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError(formatIssues(result.error));
  }
  return result.data;
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
