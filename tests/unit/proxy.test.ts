import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function makeReq(path: string, hasSessionCookie: boolean): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000" };
  const cookie = hasSessionCookie ? "sp_session=abc123" : "";
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { ...headers, cookie } : headers,
  });
}

describe("proxy — security headers", () => {
  it("attaches the required security headers to pass-through responses", () => {
    const res = proxy(makeReq("/anything", false));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe("proxy — route protection redirects", () => {
  it("redirects unauthenticated users off a protected page to /login", () => {
    const res = proxy(makeReq("/chat", false));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("carries a `next` param so the user returns after login", () => {
    const res = proxy(makeReq("/settings", false));
    expect(res.headers.get("location")).toContain("next=%2Fsettings");
  });

  it("lets authenticated users onto protected pages", () => {
    const res = proxy(makeReq("/chat", true));
    // Not a redirect — passes through (NextResponse.next()).
    const loc = res.headers.get("location");
    expect(loc).toBeNull();
  });

  it("redirects signed-in users away from /login to /chat", () => {
    const res = proxy(makeReq("/login", true));
    expect(res.headers.get("location")).toContain("/chat");
  });

  it("lets signed-out users see /login", () => {
    const res = proxy(makeReq("/login", false));
    expect(res.headers.get("location")).toBeNull();
  });
});
