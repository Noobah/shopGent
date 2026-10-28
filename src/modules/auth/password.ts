import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing (argon2id).
 *
 * argon2id is the recommended algorithm. Hashes are self-describing ($argon2id$…)
 * so parameters can be upgraded later without a format migration.
 */

// argon2id = 2 in @node-rs/argon2. The package exports `Algorithm` as an
// ambient const enum, which can't be referenced under `isolatedModules`, so we
// use the documented numeric value directly.
const ARGON2ID = 2;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, {
    algorithm: ARGON2ID,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

/** Constant-time-ish verify against a stored hash. Returns false on mismatch. */
export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain, { algorithm: ARGON2ID });
  } catch {
    // Malformed/legacy hash → treat as a failed verification, never throw.
    return false;
  }
}
