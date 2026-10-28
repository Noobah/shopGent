import { test, expect } from "@playwright/test";

/**
 * E2E: full signup → login → logout flow over real HTTP against the running app.
 *
 * Uses Playwright's API request context so cookies flow for real (the session
 * cookie is httpOnly). The UI forms arrive in Phase 5; this exercises the actual
 * routes + session lifecycle end-to-end, which is what the Phase 1 gate requires.
 */

const unique = Date.now();

test.describe("auth flow", () => {
  test("signup -> me -> logout -> me(401) -> login -> me -> logout", async ({
    request,
  }) => {
    const email = `e2e-${unique}@example.com`;
    const password = "supersecret1";

    // 1. Sign up → 201 with a safe user (no passwordHash).
    const signup = await request.post("/api/auth/signup", {
      data: { email, password, displayName: "E2E User" },
    });
    expect(signup.status()).toBe(201);
    const signupBody = await signup.json();
    expect(signupBody.user.email).toBe(email);
    expect(signupBody.user).not.toHaveProperty("passwordHash");

    // 2. Session is live → /me returns the user.
    const me1 = await request.get("/api/auth/me");
    expect(me1.status()).toBe(200);
    expect((await me1.json()).user.email).toBe(email);

    // 3. Logout → cookie cleared.
    const logout = await request.post("/api/auth/logout");
    expect(logout.status()).toBe(200);

    // 4. /me now 401s.
    const me2 = await request.get("/api/auth/me");
    expect(me2.status()).toBe(401);

    // 5. Login again with correct credentials → 200.
    const login = await request.post("/api/auth/login", {
      data: { email, password },
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).user.email).toBe(email);

    // 6. /me works again.
    const me3 = await request.get("/api/auth/me");
    expect(me3.status()).toBe(200);

    // 7. Logout once more.
    await request.post("/api/auth/logout");
    expect((await request.get("/api/auth/me")).status()).toBe(401);
  });

  test("login with wrong password and unknown email give the SAME error", async ({
    request,
  }) => {
    const email = `e2e-err-${unique}@example.com`;
    await request.post("/api/auth/signup", {
      data: { email, password: "supersecret1", displayName: "Err" },
    });
    await request.post("/api/auth/logout");

    const wrongPw = await request.post("/api/auth/login", {
      data: { email, password: "not-the-password" },
    });
    const unknown = await request.post("/api/auth/login", {
      data: { email: `ghost-${unique}@example.com`, password: "whatever" },
    });

    expect(wrongPw.status()).toBe(401);
    expect(unknown.status()).toBe(401);
    const a = await wrongPw.json();
    const b = await unknown.json();
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.code).toBe("UNAUTHORIZED");
  });

  test("unauthenticated /me returns 401 with the standardized shape", async ({
    request,
  }) => {
    const res = await request.get("/api/auth/me");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
