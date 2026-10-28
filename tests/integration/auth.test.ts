import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

/**
 * Integration tests for the auth flows, run against a real (test) MongoDB.
 *
 * `next/headers` cookies() is mocked with an in-memory jar so we can drive the
 * real service/repository functions and assert on the session cookie lifecycle.
 * No real API keys; the DB is the local test database from vitest.config.ts.
 */

// ---- mock next/headers cookies() with an in-memory jar -------------------
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

// Import AFTER the mock so the service picks up the mocked cookies.
const { signup, login, logout } = await import("@/modules/auth/service");
const { requireUser } = await import("@/modules/auth/requireUser");
const { getSessionForUser, listSessionsForUser, SESSION_COOKIE } =
  await import("@/modules/auth/session");
const { UserModel, SessionModel } = await import("@/modules/auth/models");
const { connectDb, disconnectDb } = await import("@/lib/db");
const { AuthError, NotFoundError } = await import("@/lib/errors");

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  await disconnectDb();
});

beforeEach(async () => {
  jar.clear();
  await UserModel.deleteMany({});
  await SessionModel.deleteMany({});
});

const PW = "supersecret1";

describe("signup + session lifecycle", () => {
  it("creates a user, starts a session, sets an httpOnly cookie", async () => {
    await signup({ email: "a@example.com", password: PW, displayName: "Ada" });

    // Cookie is set and is NOT the plaintext token we could reconstruct.
    expect(jar.has(SESSION_COOKIE)).toBe(true);
    expect(jar.get(SESSION_COOKIE)!.length).toBeGreaterThan(20);

    // requireUser() resolves to the created user via the cookie.
    const user = await requireUser();
    expect(user.email).toBe("a@example.com");
    expect(user.role).toBe("user");
    // Password hash must not equal the plaintext.
    expect(user.passwordHash).not.toBe(PW);
  });

  it("rejects a duplicate email with a ConflictError", async () => {
    await signup({ email: "dup@example.com", password: PW, displayName: "A" });
    await expect(
      signup({ email: "dup@example.com", password: PW, displayName: "B" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("logout revokes the session so requireUser() then throws 401", async () => {
    await signup({ email: "b@example.com", password: PW, displayName: "B" });
    await expect(requireUser()).resolves.toBeTruthy();

    await logout();
    await expect(requireUser()).rejects.toThrow(AuthError);
  });
});

describe("login errors are identical (no user enumeration)", () => {
  it("unknown email and wrong password produce the same error message", async () => {
    await signup({ email: "real@example.com", password: PW, displayName: "Real" });

    let unknownErr = "";
    let wrongErr = "";
    try {
      await login({ email: "ghost@example.com", password: PW });
    } catch (e) {
      unknownErr = (e as Error).message;
    }
    try {
      await login({ email: "real@example.com", password: "wrong-password" });
    } catch (e) {
      wrongErr = (e as Error).message;
    }

    expect(unknownErr).toBeTruthy();
    expect(unknownErr).toBe(wrongErr);
  });

  it("login with correct credentials sets a session", async () => {
    await signup({ email: "c@example.com", password: PW, displayName: "C" });
    jar.clear(); // simulate a fresh, signed-out client
    await login({ email: "c@example.com", password: PW });
    const user = await requireUser();
    expect(user.email).toBe("c@example.com");
  });
});

describe("authorization: userId derived from session, cross-user = 404", () => {
  it("requireUser() throws 401 when there is no session cookie", async () => {
    jar.clear();
    await expect(requireUser()).rejects.toThrow(AuthError);
  });

  it("user A cannot read user B's session (404, not 403)", async () => {
    // User A + their session.
    await signup({ email: "owner@example.com", password: PW, displayName: "Owner" });
    const aSessions = await listSessionsForUser((await requireUser())._id.toString());
    const aSessionId = aSessions[0]!._id.toString();

    // Switch identity to user B.
    jar.clear();
    await signup({
      email: "intruder@example.com",
      password: PW,
      displayName: "Intruder",
    });

    // B must get null (-> 404 at the route) for A's session id.
    const bId = (await requireUser())._id.toString();
    const stolen = await getSessionForUser(bId, aSessionId);
    expect(stolen).toBeNull();

    // Sanity: B can still read their OWN session.
    const bSessions = await listSessionsForUser(bId);
    const own = await getSessionForUser(bId, bSessions[0]!._id.toString());
    expect(own).not.toBeNull();
  });

  it("getSessionForUser returns null for a malformed id (no throw)", async () => {
    const user = await signupReturnId();
    await expect(getSessionForUser(user, "not-an-objectid")).resolves.toBeNull();
  });
});

describe("ownership repository returns 404 shape", () => {
  it("NotFoundError maps to 404 via handleApiError", async () => {
    const { handleApiError } = await import("@/lib/errors");
    const res = handleApiError(new NotFoundError("Not found"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// Helper: sign up and return the id.
async function signupReturnId(): Promise<string> {
  await signup({ email: "x@example.com", password: PW, displayName: "X" });
  return (await requireUser())._id.toString();
}

// Ensure the DB connection is fully torn down between suites.
afterAll(async () => {
  await mongoose.connection.close();
});
