import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin } from "@/modules/auth/origin";
import { ForbiddenError } from "@/lib/errors";

function req(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    method,
    headers,
  });
}

describe("assertSameOrigin", () => {
  it("allows safe methods with a cross-origin header", () => {
    // GET is not state-changing; origin check does not apply.
    expect(() =>
      assertSameOrigin(req("GET", { origin: "https://evil.example" })),
    ).not.toThrow();
  });

  it("allows a mutating request with no Origin header (curl, same-origin)", () => {
    expect(() => assertSameOrigin(req("POST"))).not.toThrow();
  });

  it("allows a mutating request whose Origin matches the host", () => {
    expect(() =>
      assertSameOrigin(
        req("POST", { origin: "http://localhost:3000", host: "localhost:3000" }),
      ),
    ).not.toThrow();
  });

  it("rejects a mutating request from a different origin", () => {
    expect(() =>
      assertSameOrigin(
        req("POST", { origin: "https://evil.example", host: "localhost:3000" }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("rejects cross-origin DELETE", () => {
    expect(() =>
      assertSameOrigin(
        req("DELETE", { origin: "https://evil.example", host: "localhost:3000" }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("honors x-forwarded-host/proxy headers when computing the expected origin", () => {
    // Behind a proxy that terminates TLS, x-forwarded-* reflect the real host.
    expect(() =>
      assertSameOrigin(
        req("POST", {
          origin: "https://shop.example",
          "x-forwarded-host": "shop.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).not.toThrow();
  });
});
