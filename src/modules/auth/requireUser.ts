import { AuthError, NotFoundError } from "@/lib/errors";
import { getSessionToken, getSessionFromToken, type ResolvedSession } from "./session";
import type { UserDoc } from "./models";

/**
 * Authentication + authorization guards.
 *
 * Every API route and Server Action calls `requireUser()` — middleware/proxy is
 * only a convenience redirect, never the source of truth. The userId is ALWAYS
 * derived from the session cookie, never accepted from the client.
 */

/** Resolve the current session or throw 401. Use in protected routes/actions. */
export async function requireUser(): Promise<UserDoc> {
  const session = await requireSession();
  return session.user;
}

/** Resolve the full session (user + auth session) or throw 401. */
export async function requireSession(): Promise<ResolvedSession> {
  const raw = await getSessionToken();
  if (!raw) throw new AuthError("Authentication required");

  const resolved = await getSessionFromToken(raw);
  if (!resolved) throw new AuthError("Authentication required");

  return resolved;
}

/** Non-throwing variant: returns the user or null (for optional auth). */
export async function getCurrentUser(): Promise<UserDoc | null> {
  const raw = await getSessionToken();
  if (!raw) return null;
  const resolved = await getSessionFromToken(raw);
  return resolved?.user ?? null;
}

/**
 * Assert a resource belongs to `userId`. Centralizes the ownership filter so a
 * forgotten check is hard to write. Per the prompt, another user's resource
 * returns 404 (NOT 403) so we never leak its existence.
 */
export function assertOwnership(
  resource: { ownerId: string } | null | undefined,
  userId: string,
  notFoundMessage = "Not found",
): asserts resource is { ownerId: string } {
  if (!resource || resource.ownerId !== userId) {
    throw new NotFoundError(notFoundMessage);
  }
}
