import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExternalServiceError } from "@/lib/errors";
import { resetEnvCache } from "@/lib/env";
import {
  createProductSource,
  getProductSource,
  getTrustPolicy,
  setProductSource,
} from "@/modules/products";
import { LiveSource } from "@/modules/products/sources/live";
import { MockSource } from "@/modules/products/sources/mock";

/**
 * Product factory tests — provider selection is env-driven, mirroring the LLM
 * seam. `live` must fail loudly without a base URL: silently falling back to
 * the mock would present fabricated catalog data as a real search.
 */

const ORIGINAL = { ...process.env };
const mutableEnv = process.env as unknown as Record<string, string | undefined>;

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
  setProductSource(null);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete mutableEnv[key];
  }
  Object.assign(mutableEnv, ORIGINAL);
  resetEnvCache();
  setProductSource(null);
});

describe("createProductSource", () => {
  it("defaults to the mock when PRODUCT_SOURCE is unset", () => {
    setEnv({ PRODUCT_SOURCE: undefined });
    expect(createProductSource()).toBeInstanceOf(MockSource);
  });

  it("returns the mock when PRODUCT_SOURCE=mock", () => {
    setEnv({ PRODUCT_SOURCE: "mock" });
    expect(createProductSource()).toBeInstanceOf(MockSource);
  });

  it("returns LiveSource when PRODUCT_SOURCE=live and a base URL is set", () => {
    setEnv({
      PRODUCT_SOURCE: "live",
      PRODUCT_SOURCE_BASE_URL: "https://api.example.com",
    });
    const source = createProductSource();
    expect(source).toBeInstanceOf(LiveSource);
    expect(source.id).toBe("live");
  });

  it("fails loudly when PRODUCT_SOURCE=live but no base URL is configured", () => {
    setEnv({ PRODUCT_SOURCE: "live", PRODUCT_SOURCE_BASE_URL: undefined });

    expect(() => createProductSource()).toThrow(ExternalServiceError);
    expect(() => createProductSource()).toThrow(/PRODUCT_SOURCE_BASE_URL/);
  });

  it("lets explicit options override env (used by tests)", () => {
    setEnv({ PRODUCT_SOURCE: "mock" });
    const source = createProductSource({
      provider: "live",
      baseUrl: "https://api.example.com",
    });

    expect(source).toBeInstanceOf(LiveSource);
  });

  it("returns a stable singleton from getProductSource until reset", () => {
    setEnv({ PRODUCT_SOURCE: "mock" });
    const first = getProductSource();
    const second = getProductSource();

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(MockSource);

    setProductSource(null);
    expect(getProductSource()).not.toBe(first);
  });
});

describe("getTrustPolicy", () => {
  it("defaults to a 4.0 rating and 50 ratings", () => {
    setEnv({ TRUST_MIN_RATING: undefined, TRUST_MIN_RATING_COUNT: undefined });

    expect(getTrustPolicy()).toEqual({
      minRating: 4.0,
      minRatingCount: 50,
      officialBypass: true,
    });
  });

  it("reads configured thresholds from env", () => {
    setEnv({ TRUST_MIN_RATING: "4.5", TRUST_MIN_RATING_COUNT: "1000" });

    const policy = getTrustPolicy();
    expect(policy.minRating).toBe(4.5);
    expect(policy.minRatingCount).toBe(1000);
  });
});
