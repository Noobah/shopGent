import { env } from "@/lib/env";
import { ExternalServiceError } from "@/lib/errors";
import { GrokProvider } from "./grok";
import { MockProvider } from "./mock";
import type { LLMProvider } from "./provider";

/**
 * LLM factory — the single place that decides which provider is constructed.
 *
 * Driven entirely by env (LLM_PROVIDER + GROK_* / SHOPSY_*). Swapping providers
 * is an env change; agent code never imports a concrete adapter, only this
 * factory and the LLMProvider interface. The mock is the default so the app and
 * every test run with no API key.
 */

/** Options for constructing a provider, used to override env in tests. */
export interface LLMFactoryOptions {
  provider?: "mock" | "grok" | "groq";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch so tests can mock the HTTP layer. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Build a provider from explicit options (falls back to validated env). */
export function createLLMProvider(options: LLMFactoryOptions = {}): LLMProvider {
  const provider = options.provider ?? env.LLM_PROVIDER;

  if (provider === "mock") {
    return new MockProvider({ model: options.model ?? "mock-model" });
  }

  if (provider === "grok" || provider === "groq") {
    // Both vendors expose an OpenAI-compatible chat-completions API, so they
    // share one adapter — only credentials/model/base URL differ. Groq's key
    // is the user-supplied SHOPSY_API_KEY.
    const isGroq = provider === "groq";
    const apiKey = options.apiKey ?? (isGroq ? env.SHOPSY_API_KEY : env.GROK_API_KEY);
    const missing = isGroq ? "SHOPSY_API_KEY" : "GROK_API_KEY";
    if (!apiKey) {
      // Fail loudly and early rather than silently falling back to the mock —
      // a misconfigured provider must not masquerade as success.
      throw new ExternalServiceError(
        502,
        `LLM_PROVIDER=${provider} but ${missing} is not set`,
      );
    }
    return new GrokProvider({
      apiKey,
      model: options.model ?? (isGroq ? env.SHOPSY_MODEL : env.GROK_MODEL),
      baseUrl: options.baseUrl ?? (isGroq ? env.SHOPSY_BASE_URL : env.GROK_BASE_URL),
      id: provider,
      label: isGroq ? "Groq" : "Grok",
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
