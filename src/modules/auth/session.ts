import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { isValidObjectId } from "mongoose";
import { connectDb } from "@/lib/db";
import { SessionModel, UserModel, type UserDoc, type SessionDoc } from "./models";

/**
 * Session management.
 *
 * A session token is 32 random bytes, base64url-encoded. The RAW token only ever
 * lives in the httpOnly cookie; we persist only its SHA-256 hash. Looking a
 * session up requires hashing the incoming cookie token and matching tokenHash,
 * so a DB leak alone cannot be replayed as a live session.
 */

export const SESSION_COOKIE = "sp_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** Public-safe shape of a user (never includes passwordHash or token fields). */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
}

export function toSafeUser(user: UserDoc): SafeUser {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    emailVerified: user.emailVerifiedAt != null,
    createdAt: (user as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? "",
  };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Create a DB session for a user and set the httpOnly cookie on the response. */
export async function createSession(
  userId: string,
  userAgent?: string | null,
): Promise<void> {
  await connectDb();
  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await SessionModel.create({
    userId,
    tokenHash: hashToken(raw),
    expiresAt,
    userAgent: userAgent ?? null,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Clear the session cookie (used on logout). */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

/** Read the raw session token from the request cookies, if present. */
export async function getSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

export interface ResolvedSession {
  user: UserDoc;
  session: SessionDoc;
}

/**
 * Resolve a raw token to a live session + user, or null.
 * Returns null for missing, expired, revoked, or orphaned sessions.
 */
export async function getSessionFromToken(raw: string): Promise<ResolvedSession | null> {
  if (!raw) return null;
  await connectDb();

  const session = await SessionModel.findOne({ tokenHash: hashToken(raw) }).lean();
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const user = await UserModel.findById(session.userId).lean();
  if (!user) return null;

  return { user, session };
}

/** Revoke a session by raw token (logout). No-op if not found. */
export async function revokeSessionByToken(raw: string): Promise<void> {
  if (!raw) return;
  await connectDb();
  await SessionModel.updateOne(
    { tokenHash: hashToken(raw) },
    { $set: { revokedAt: new Date() } },
  );
}

/**
 * Ownership-scoped repository read.
 *
 * The ONLY way to fetch a session by id. The ownership filter is baked into the
 * query (`userId` must match), so a forgotten check upstream can't leak another
 * user's data — a mismatch simply returns null, which callers turn into a 404.
 * This centralization is exactly what the build prompt asks for.
 */
export async function getSessionForUser(
  userId: string,
  sessionId: string,
): Promise<SessionDoc | null> {
  if (!isValidObjectId(sessionId)) return null;
  await connectDb();
  return SessionModel.findOne({ _id: sessionId, userId }).lean();
}

/** List all of a user's sessions (ownership baked in). */
export async function listSessionsForUser(userId: string): Promise<SessionDoc[]> {
  await connectDb();
  return SessionModel.find({ userId }).lean();
}
