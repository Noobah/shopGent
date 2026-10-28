import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, resetEnvCache, env } from "@/lib/env";

const ORIGINAL = { ...process.env };

// `process.env` values (notably NODE_ENV) are typed read-only by Node; tests
// need to mutate them, so route all writes through this mutable alias.
const mutableEnv = process.env as unknown as Record<string, string | undefined>;

const URI = "mongodb://127.0.0.1:27017/shoppilot";

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete mutableEnv[key];
  }
  Object.assign(mutableEnv, ORIGINAL);
  resetEnvCache();
});

describe("env validation", () => {
  it("passes with a valid MONGODB_URI and exposes typed values", () => {
    mutableEnv.MONGODB_URI = URI;
    mutableEnv.NODE_ENV = "test";

    const e = getEnv();
    expect(e.MONGODB_URI).toBe(URI);
    expect(e.NODE_ENV).toBe("test");
  });

  it("defaults NODE_ENV to development when unset", () => {
    delete mutableEnv.NODE_ENV;
    mutableEnv.MONGODB_URI = URI;

    expect(getEnv().NODE_ENV).toBe("development");
  });

  it("throws a readable error when MONGODB_URI is missing", () => {
    delete mutableEnv.MONGODB_URI;

    expect(() => getEnv()).toThrow(/MONGODB_URI/);
  });

  it("throws on an invalid NODE_ENV enum value", () => {
    mutableEnv.MONGODB_URI = URI;
    mutableEnv.NODE_ENV = "staging";

    expect(() => getEnv()).toThrow(/NODE_ENV/);
  });

  it("caches the parsed env after the first successful parse", () => {
    mutableEnv.MONGODB_URI = URI;
    const first = getEnv();
    // Mutating process.env after caching must NOT change the cached value.
    mutableEnv.MONGODB_URI = "mongodb://changed";
    const second = getEnv();
    expect(second).toBe(first);
    expect(second.MONGODB_URI).toBe(URI);
  });

  it("lazy proxy does not throw on import, only on access", () => {
    // env is imported at module load above; ensure access triggers validation.
    delete mutableEnv.MONGODB_URI;
    expect(() => env.MONGODB_URI).toThrow(/MONGODB_URI/);
  });
});
