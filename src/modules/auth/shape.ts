import type { SessionDoc } from "./models";

/** Public-safe shape of an auth session (never exposes tokenHash/userId). */
export interface SafeSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export function shapeSession(s: SessionDoc): SafeSession {
  const timestamps = s as unknown as { createdAt?: Date };
  return {
    id: s._id.toString(),
    createdAt: timestamps.createdAt?.toISOString() ?? "",
    expiresAt: s.expiresAt.toISOString(),
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
  };
}
