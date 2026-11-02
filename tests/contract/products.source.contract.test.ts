import { describe, it, expect } from "vitest";
import {
  searchProductsParamsSchema,
  type SearchProductsParams,
} from "@/modules/products/source";
import { LiveSource, type LiveSourceOptions } from "@/modules/products/sources/live";
import { MockSource } from "@/modules/products/sources/mock";
import { productSchema } from "@/modules/products/types";
import type { RawProduct } from "@/modules/products/normalize";

/**
 * ProductSource contract — the SAME suite runs against every adapter.
 *
 * Any new source must satisfy these before an agent may rely on it: valid
 * normalized records, a hard result cap, abort handling, and getById semantics.
 * The live adapter is exercised through an injected fetch, so no network/keys.
 */

const params = (overrides: Partial<SearchProductsParams> = {}): SearchProductsParams =>
  searchProductsParamsSchema.parse(overrides);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A minimal but complete vendor record in RUPEES (normalize converts). */
const RAW: RawProduct = {
  id: "live-1",
  title: "Acme Live Test Monitor 27-inch",
  brand: "Acme",
  category: "electronics",
  modelNumber: "ACM-27X",
  price: 1299.5,
  mrp: 1599,
  rating: 4.5,
  ratingCount: 100,
  sellerName: "Acme Official Store",
  isOfficialStore: true,
  inStock: true,
  deliveryEstimate: "Delivery in 3-4 days",
  url: "https://example.com/p/live-1",
  imageUrl: "https://example.com/p/live-1.jpg",
};

function makeLive(overrides: Partial<LiveSourceOptions> = {}): LiveSource {
  return new LiveSource({
    baseUrl: "https://api.example.com",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/products/")) {
        // The contract's shared "unknown id" case: a 404 means "no product".
        if (url.endsWith("/missing")) return json({ error: "not found" }, 404);
        return json(RAW);
      }
      return json({ products: [RAW] });
    },
    ...overrides,
  });
}

const implementations = [
  { name: "MockSource", create: () => new MockSource(), knownId: "el-mon-001" },
  { name: "LiveSource", create: () => makeLive(), knownId: "live-1" },
];

for (const { name, create, knownId } of implementations) {
  describe(`ProductSource contract — ${name}`, () => {
    it("search returns non-empty, schema-valid, source-stamped products", async () => {
      const source = create();
      const results = await source.search(params({ limit: 5 }));

      expect(results.length).toBeGreaterThan(0);
      for (const product of results) {
        expect(productSchema.safeParse(product).success).toBe(true);
        expect(product.source).toBe(source.id);
        expect(Number.isInteger(product.price)).toBe(true);
        expect(product.price).toBeGreaterThanOrEqual(0);
      }
    });

    it("honours the hard result cap even when the vendor returns more", async () => {
      const source = create();
      const results = await source.search(params({ limit: 1 }));
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("rejects an already-aborted search", async () => {
      const source = create();
      const controller = new AbortController();
      controller.abort();

      await expect(
        source.search(params({ signal: controller.signal })),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_ERROR",
        statusCode: 504,
      });
    });

    it("getById returns a schema-valid record for a known id", async () => {
      const source = create();
      const product = await source.getById(knownId);

      expect(product).not.toBeNull();
      expect(product!.id).toBe(knownId);
      expect(product!.source).toBe(source.id);
      expect(productSchema.safeParse(product).success).toBe(true);
    });

    it("getById returns null for an unknown id (not an exception)", async () => {
      const source = create();
      expect(await source.getById("missing")).toBeNull();
    });
  });
}

describe("LiveSource — wire contract", () => {
  it("builds the search URL and sends the bearer token when configured", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const source = makeLive({
      apiKey: "test-key",
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenInit = init;
        return json({ products: [] });
      },
    });

    await source.search(params({ query: "monitor", category: "electronics", limit: 7 }));

    const url = new URL(seenUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.example.com/search");
    expect(url.searchParams.get("query")).toBe("monitor");
    expect(url.searchParams.get("category")).toBe("electronics");
    expect(url.searchParams.get("limit")).toBe("7");

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer test-key");
  });

  it("accepts a bare array payload as well as { products: [...] }", async () => {
    const source = makeLive({ fetchImpl: async () => json([RAW]) });
    const results = await source.search(params({ limit: 10 }));

    expect(results.map((p) => p.id)).toEqual(["live-1"]);
  });

  it("enforces maxPrice/minRating/officialOnly locally when the vendor ignores them", async () => {
    const cheapOfficial: RawProduct = {
      ...RAW,
      id: "cheap-official",
      price: 150,
      rating: 4.8,
      isOfficialStore: true,
    };
    const expensiveOfficial: RawProduct = {
      ...RAW,
      id: "expensive-official",
      price: 900,
      rating: 4.8,
      isOfficialStore: true,
    };
    const cheapThirdParty: RawProduct = {
      ...RAW,
      id: "cheap-third-party",
      price: 150,
      rating: 3.0,
      isOfficialStore: false,
    };

    const source = makeLive({
      fetchImpl: async () =>
        json({ products: [cheapOfficial, expensiveOfficial, cheapThirdParty] }),
    });

    const results = await source.search(
      params({ maxPricePaise: 200_00, minRating: 4.5, officialOnly: true, limit: 10 }),
    );

    expect(results.map((p) => p.id)).toEqual(["cheap-official"]);
  });

  it("truncates an over-eager vendor response to the requested limit", async () => {
    const extras: RawProduct[] = [1, 2, 3].map((n) => ({ ...RAW, id: `live-${n}` }));
    const source = makeLive({ fetchImpl: async () => json({ products: extras }) });

    const results = await source.search(params({ limit: 2 }));
    expect(results).toHaveLength(2);
  });

  it("skips malformed records instead of failing the whole search", async () => {
    const noIdentity: RawProduct = {
      ...RAW,
      id: "bad",
      modelNumber: undefined,
      ean: undefined,
    };
    const source = makeLive({
      fetchImpl: async () => json({ products: [RAW, noIdentity] }),
    });

    const results = await source.search(params({ limit: 10 }));
    expect(results.map((p) => p.id)).toEqual(["live-1"]);
  });

  it("maps a non-2xx response to ExternalServiceError 502", async () => {
    const source = makeLive({ fetchImpl: async () => json({ error: "boom" }, 500) });

    await expect(source.search(params({}))).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 502,
    });
  });

  it("maps invalid JSON to ExternalServiceError 502", async () => {
    const source = makeLive({
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });

    await expect(source.search(params({}))).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 502,
    });
  });

  it("maps a timeout to ExternalServiceError 504", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });

    const source = makeLive({ fetchImpl: hangingFetch, timeoutMs: 5 });

    await expect(source.search(params({}))).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 504,
    });
  });

  it("maps a caller abort to ExternalServiceError 504 (not a timeout)", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });

    const source = makeLive({ fetchImpl: hangingFetch, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = source.search(params({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 504,
      message: expect.stringMatching(/aborted/),
    });
  });

  it("getById accepts a wrapped { product } payload and stamps source=live", async () => {
    const source = makeLive({ fetchImpl: async () => json({ product: RAW }) });
    const product = await source.getById("live-1");

    expect(product).not.toBeNull();
    expect(product!.source).toBe("live");
    expect(productSchema.safeParse(product).success).toBe(true);
  });
});
