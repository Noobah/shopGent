import { describe, it, expect } from "vitest";
import { ExternalServiceError } from "@/lib/errors";
import {
  searchProductsParamsSchema,
  type SearchProductsParams,
} from "@/modules/products/source";
import { MockSource } from "@/modules/products/sources/mock";
import { MOCK_FETCHED_AT, MOCK_PRODUCTS } from "@/modules/products/sources/mock.data";
import { productSchema, type Product } from "@/modules/products/types";

/**
 * MockSource tests — the default ProductSource for dev and every test.
 *
 * Determinism is the contract: same params in, same records out, no clock, no
 * network, every record schema-valid. Filters are enforced in code because the
 * agent must never see a product outside the user's constraints.
 */

/** Resolve schema defaults (notably `limit`) exactly as tools will. */
const params = (overrides: Partial<SearchProductsParams> = {}): SearchProductsParams =>
  searchProductsParamsSchema.parse(overrides);

describe("MockSource — search", () => {
  it("returns schema-valid products stamped with source and fixture time", async () => {
    const source = new MockSource();
    const results = await source.search(params({ limit: 5 }));

    expect(results.length).toBeGreaterThan(0);
    for (const product of results) {
      expect(productSchema.safeParse(product).success).toBe(true);
      expect(product.source).toBe("mock");
      // Fixtures carry a fixed UTC timestamp; the mock must never use the clock.
      expect(product.fetchedAt).toBe(MOCK_FETCHED_AT);
    }
  });

  it("caps results at `limit` (default 10 when omitted)", async () => {
    const source = new MockSource();
    expect(await source.search(params({ limit: 5 }))).toHaveLength(5);
    expect(await source.search(params({}))).toHaveLength(10);
    expect(MOCK_PRODUCTS.length).toBeGreaterThan(10);
  });

  it("is deterministic — same params in, identical records out", async () => {
    const source = new MockSource();
    const a = await source.search(params({ query: "logitech", limit: 10 }));
    const b = await source.search(params({ query: "logitech", limit: 10 }));
    expect(a).toEqual(b);
  });

  it("filters by category", async () => {
    const source = new MockSource();
    const results = await source.search(params({ category: "home", limit: 50 }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.category === "home")).toBe(true);
  });

  it("filters by max price (paise)", async () => {
    const source = new MockSource();
    const results = await source.search(params({ maxPricePaise: 150_000, limit: 50 }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.price <= 150_000)).toBe(true);
  });

  it("filters by minimum rating", async () => {
    const source = new MockSource();
    const results = await source.search(params({ minRating: 4.5, limit: 50 }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.rating >= 4.5)).toBe(true);
  });

  it("filters to official stores only", async () => {
    const source = new MockSource();
    const results = await source.search(params({ officialOnly: true, limit: 50 }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.isOfficialStore)).toBe(true);
  });

  it("matches free text against brand/title without title-only identity rules", async () => {
    const source = new MockSource();
    const results = await source.search(params({ query: "logitech", limit: 50 }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.map((p) => p.id)).toContain("el-ms-001");
    for (const product of results) {
      expect(
        `${product.title} ${product.brand} ${product.modelNumber}`.toLowerCase(),
      ).toContain("logitech");
    }
  });

  it("matches model numbers (e.g. 27UL650)", async () => {
    const source = new MockSource();
    const results = await source.search(params({ query: "27UL650", limit: 10 }));
    const ids = results.map((p) => p.id);

    expect(ids).toContain("el-mon-001");
    expect(ids).toContain("el-mon-002");
  });

  it("rejects an already-aborted search instead of returning data", async () => {
    const source = new MockSource();
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.search(params({ signal: controller.signal })),
    ).rejects.toMatchObject({
      name: ExternalServiceError.name,
      statusCode: 504,
      code: "EXTERNAL_SERVICE_ERROR",
    });
  });
});

describe("MockSource — getById", () => {
  it("returns a schema-valid product by id", async () => {
    const source = new MockSource();
    const product = await source.getById("el-mon-001");

    expect(product).not.toBeNull();
    expect(product!.id).toBe("el-mon-001");
    expect(productSchema.safeParse(product).success).toBe(true);
  });

  it("returns null for an unknown id (never fabricates a record)", async () => {
    const source = new MockSource();
    expect(await source.getById("does-not-exist")).toBeNull();
  });

  it("rejects an already-aborted lookup", async () => {
    const source = new MockSource();
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.getById("el-mon-001", { signal: controller.signal }),
    ).rejects.toMatchObject({ statusCode: 504, code: "EXTERNAL_SERVICE_ERROR" });
  });

  it("stamps a configured fetchedAt (used by price-freshness tests)", async () => {
    const when = "2026-02-01T00:00:00.000Z";
    const source = new MockSource({ fetchedAt: when });
    const results = await source.search(params({ limit: 1 }));

    expect(results[0]!.fetchedAt).toBe(when);
    expect((await source.getById("el-mon-001"))!.fetchedAt).toBe(when);
  });

  it("can search a caller-supplied fixture set", async () => {
    const only: Product = MOCK_PRODUCTS.find((p) => p.id === "el-ms-001")!;
    const source = new MockSource({ products: [only] });

    const results = await source.search(params({ limit: 10 }));
    expect(results.map((p) => p.id)).toEqual(["el-ms-001"]);
    expect(await source.getById("el-mon-001")).toBeNull();
  });
});
