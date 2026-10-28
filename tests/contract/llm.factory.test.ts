import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLLMProvider, getLLMProvider, setLLMProvider } from "@/modules/llm";
import { MockProvider } from "@/modules/llm/mock";
import { GrokProvider } from "@/modules/llm/grok";
import { resetEnvCache } from "@/lib/env";

/**
 * Factory tests — prove the provider is chosen purely by env/options, and that
 * switching providers requires NO change to any other file (the Phase 2 gate).
 */

const ORIGINAL = { ...process.env };
const mutableEnv = process.env as unknown as Record<string, string | undefined>;

/**
 * Mutate process.env and clear the validation cache.
 *
 * `getEnv()` parses and caches on first property access (so the app reads env
 * once, immutable thereafter). A test that flips env MID-TEST must clear that
 * cache — that's exactly what `resetEnvCache()` exists for.
 */
function setEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
  setLLMProvider(null);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete mutableEnv[key];
  }
  Object.assign(mutableEnv, ORIGINAL);
  resetEnvCache();
  setLLMProvider(null);
});

describe("createLLMProvider", () => {
  it("defaults to the mock when LLM_PROVIDER is unset", () => {
    setEnv({ LLM_PROVIDER: undefined });
    // No API key present — the mock must be selected without needing one.
    expect(createLLMProvider()).toBeInstanceOf(MockProvider);
  });

  it("returns the mock when LLM_PROVIDER=mock", () => {
    setEnv({ LLM_PROVIDER: "mock" });
    expect(createLLMProvider()).toBeInstanceOf(MockProvider);
  });

  it("returns GrokProvider when LLM_PROVIDER=grok and a key is provided", () => {
    setEnv({ LLM_PROVIDER: "grok" });
    setEnv({ GROK_API_KEY: "sk-test" });
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(GrokProvider);
    expect(p.id).toBe("grok");
  });

  it("throws (does NOT silently fall back to mock) when grok lacks a key", () => {
    setEnv({ LLM_PROVIDER: "grok" });
    setEnv({ GROK_API_KEY: undefined });
    expect(() => createLLMProvider()).toThrow(/GROK_API_KEY/);
  });

  it("explicit options override env entirely", () => {
    setEnv({ LLM_PROVIDER: "mock" });
    // Ask for grok explicitly, with a key — must win over the env mock.
    const p = createLLMProvider({
      provider: "grok",
      apiKey: "sk-explicit",
      fetchImpl: async () => new Response("data: [DONE]\n\n", { status: 200 }),
    });
    expect(p).toBeInstanceOf(GrokProvider);
  });

  it("uses the env model for grok when no explicit model is given", () => {
    setEnv({ LLM_PROVIDER: "grok" });
    setEnv({ GROK_API_KEY: "sk-test" });
    setEnv({ GROK_MODEL: "grok-4-turbo" });
    const p = createLLMProvider();
    expect(p.model).toBe("grok-4-turbo");
  });
});

describe("provider switching via env (no code change)", () => {
  it("the same factory call returns different adapters as env flips", () => {
    // Simulate flipping only the env var — the factory call site never changes.
    setEnv({ LLM_PROVIDER: "mock" });
    const a = createLLMProvider();

    setEnv({ LLM_PROVIDER: "grok" });
    setEnv({ GROK_API_KEY: "sk-test" });
    const b = createLLMProvider();

    expect(a.id).toBe("mock");
    expect(b.id).toBe("grok");
  });
});

describe("getLLMProvider singleton", () => {
  it("memoizes the first constructed provider", () => {
    setEnv({ LLM_PROVIDER: undefined });
    const first = getLLMProvider();
    expect(getLLMProvider()).toBe(first);
  });

  it("setLLMProvider(null) forces a fresh construction", () => {
    const a = getLLMProvider();
    setLLMProvider(null);
    const b = getLLMProvider();
    expect(b).not.toBe(a);
  });

  it("setLLMProvider can inject a custom instance", () => {
    const custom = new MockProvider({ model: "injected" });
    setLLMProvider(custom);
    expect(getLLMProvider()).toBe(custom);
  });
});

describe("no-API-key guarantee", () => {
  it("the default (unset env) never requires GROK_API_KEY", () => {
    setEnv({ LLM_PROVIDER: undefined });
    setEnv({ GROK_API_KEY: undefined });
    // Must not throw — this is what lets the whole test suite run keyless.
    expect(() => createLLMProvider()).not.toThrow();
  });
});
