import { describe, it, expect } from "vitest";
import { redact } from "@/lib/logger";

describe("logger redact", () => {
  it("redacts email addresses inside strings", () => {
    const out = redact("contact bob@example.com for help") as string;
    expect(out).not.toContain("bob@example.com");
    expect(out).toContain("[redacted-email]");
  });

  it("redacts values under secret-looking keys", () => {
    const out = redact({ apiKey: "sk-live-123", password: "hunter2" }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
  });

  it("redacts connection strings", () => {
    const out = redact({ uri: "mongodb://user:pass@host/db" }) as Record<string, unknown>;
    expect(out.uri).toBe("[redacted]");
  });

  it("redacts nested emails and secrets recursively", () => {
    const out = redact({
      user: { email: "a@b.com", name: "Ada" },
      token: "abc",
    }) as { user: { email: string; name: string }; token: string };

    expect(out.user.email).toBe("[redacted-email]");
    expect(out.user.name).toBe("Ada"); // non-secret preserved
    expect(out.token).toBe("[redacted]");
  });

  it("leaves plain non-secret values intact", () => {
    expect(redact("just a message")).toBe("just a message");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });

  it("redacts emails inside Error messages", () => {
    const err = new Error("failed for user a@b.com");
    const out = redact(err) as { message: string };
    expect(out.message).not.toContain("a@b.com");
  });
});
