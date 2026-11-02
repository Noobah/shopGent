import { env } from "@/lib/env";
import { ExternalServiceError } from "@/lib/errors";
import { LiveSource } from "./sources/live";
import { MockSource } from "./sources/mock";
import type { ProductSource } from "./source";
import { trustPolicySchema, type TrustPolicy } from "./trust";

/**
 * Product factory — the single place that decides which ProductSource is used.
 *
 * Mirrors `llm/index.ts`: driven entirely by env (PRODUCT_SOURCE +_* config),
 * so switching from the mock fixtures to a live vendor is a config change.
 * Agent code imports only this factory and the `ProductSource` interface.
 *
 * The mock is the default, so dev and every test run with zero network and
 * zero keys. `live` fails loudly when PRODUCT_SOURCE_BASE_URL is missing —
 * never a silent fallback that would pretend to be a real search.
 */

/** Options for constructing a source, used to override env in tests. */
export interface ProductSourceFactoryOptions {
  provider?: "mock" | "live";
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable fetch so tests can mock the live HTTP layer. */
  fetchImpl?: typeof fetch;
}

/** Build a source from explicit options (falls back to validated env). */
export function createProductSource(
  options: ProductSourceFactoryOptions = {},
): ProductSource {
  const provider = options.provider ?? env.PRODUCT_SOURCE;

  if (provider === "mock") {
    return new MockSource();
  }

  if (provider === "live") {
    const baseUrl = options.baseUrl ?? env.PRODUCT_SOURCE_BASE_URL;
    if (!baseUrl) {
      // Fail loudly: a misconfigured live source must not masquerade as the
      // mock (that would be inventing catalog data).
      throw new ExternalServiceError(
        502,
        "PRODUCT_SOURCE=live but PRODUCT_SOURCE_BASE_URL is not set",
      );
    }
    return new LiveSource({
      baseUrl,
      apiKey: options.apiKey ?? env.PRODUCT_SOURCE_API_KEY,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  // Unreachable: the enum constrains the union. Kept as a total guard.
  throw new ExternalServiceError(502, `Unknown product source: ${String(provider)}`);
}

/** Singleton accessor for app code. Tests can call createProductSource directly. */
let instance: ProductSource | null = null;

export function getProductSource(): ProductSource {
  if (!instance) instance = createProductSource();
  return instance;
}

/** Test helper: inject or reset the singleton. */
export function setProductSource(source: ProductSource | null): void {
  instance = source;
}

/**
 * The seller-trust policy, from env (TRUST_MIN_RATING / TRUST_MIN_RATING_COUNT).
 *
 * Code-enforced: tools and ranking read this, never the LLM. Parsed on each
 * call so tests can flip env and see the new thresholds immediately.
 */
export function getTrustPolicy(): TrustPolicy {
  return trustPolicySchema.parse({
    minRating: env.TRUST_MIN_RATING,
    minRatingCount: env.TRUST_MIN_RATING_COUNT,
  });
}

// Re-export the whole seam so agent code has one import path.
export * from "./source";
export * from "./types";
export * from "./trust";
export * from "./match";
export * from "./normalize";
export { MockSource } from "./sources/mock";
export { LiveSource } from "./sources/live";
