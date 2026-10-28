import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/modules/auth/password";

describe("password hashing", () => {
  it("produces an argon2id hash", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("never stores the plaintext", async () => {
    const hash = await hashPassword("super-secret-123");
    expect(hash).not.toContain("super-secret-123");
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    await expect(verifyPassword(hash, "hunter2hunter2")).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("salts hashes (same password -> different hashes)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("returns false (does not throw) on a malformed stored hash", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });
});
