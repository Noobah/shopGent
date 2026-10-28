import { env } from "@/lib/env";
import { ExternalServiceError } from "@/lib/errors";
import { GrokProvider } from "./grok";
import { MockProvider } from "./mock";
import type { LLMProvider } from "./provider";

/**
 * LLM factory — the single place that decides which provider is constructed.
 *
 * Driven entirely by env (LLM_PROVIDER + GROK_*). Swapping providers is an env
 * change; agent code never imports a concrete adapter, only this factory and
 * the LLMProvider interface. The mock is the default so the app and every test
 * run with no API key.
 */

/** Options for constructing a provider, used to override env in tests. */
export interface LLMFactoryOptions {
  provider?: "mock" | "grok";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch so tests can mock the Grok HTTP layer. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Build a provider from explicit options (falls back to validated env). */
export function createLLMProvider(options: LLMFactoryOptions = {}): LLMProvider {
  const provider = options.provider ?? env.LLM_PROVIDER;

  if (provider === "mock") {
    return new MockProvider({ model: options.model ?? "mock-model" });
  }

  if (provider === "grok") {
    const apiKey = options.apiKey ?? env.GROK_API_KEY;
    if (!apiKey) {
      // Fail loudly and early rather than silently falling back to the mock —
      // a misconfigured provider must not masquerade as success.
      throw new ExternalServiceError(
        502,
        "LLM_PROVIDER=grok but GROK_API_KEY is not set",
      );
    }
    return new GrokProvider({
      apiKey,
      model: options.model ?? env.GROK_MODEL,
      baseUrl: options.baseUrl ?? env.GROK_BASE_URL,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  // Unreachable: the enum constrains the union. Kept as a total guard.
  throw new ExternalServiceError(502, `Unknown LLM provider: ${String(provider)}`);
}

/** Singleton accessor for app code. Tests can call createLLMProvider directly. */
let instance: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (!instance) instance = createLLMProvider();
  return instance;
}

/** Test helper: inject or reset the singleton. */
export function setLLMProvider(provider: LLMProvider | null): void {
  instance = provider;
}

export * from "./provider";
export { MockProvider } from "./mock";
export { GrokProvider } from "./grok";
