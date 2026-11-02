import { describe, it, expect } from "vitest";
import {
  normalizeCategory,
  normalizeProduct,
  normalizeProducts,
  toPaise,
  type RawProduct,
} from "@/modules/products/normalize";
import { productSchema } from "@/modules/products/types";

/**
 * normalize.ts tests — untrusted vendor payload → validated Product.
 *
 * The invariants: money becomes integer paise with explicit half-up rounding,
 * nothing is invented (no MRP/discount, no identifier), and a record without a
 * model number or EAN is rejected outright — titles are never identity.
 */

const raw = (overrides: Partial<RawProduct> = {}): RawProduct => ({
  id: "p-1",
  title: "Test Monitor 27-inch",
  brand: "TestBrand",
  category: "electronics",
  modelNumber: "TM-100",
  price: 1299.5,
  mrp: 1599,
  rating: 4.5,
  ratingCount: 100,
  sellerName: "Test Seller",
  isOfficialStore: true,
  inStock: true,
  deliveryEstimate: "Delivery in 3-4 days",
  url: "https://example.com/p/1",
  imageUrl: "https://example.com/p/1.jpg",
  ...overrides,
});

const options = { source: "live", fetchedAt: "2026-01-15T00:00:00.000Z" };

describe("toPaise", () => {
  it("treats numbers as rupees and returns integer paise", () => {
    expect(toPaise(1299)).toBe(129_900);
    expect(toPaise(1299.5)).toBe(129_950);
    expect(toPaise(0)).toBe(0);
  });

  it("parses formatted rupee strings, including the ₹ symbol and commas", () => {
    expect(toPaise("₹1,299.50")).toBe(129_950);
    expect(toPaise("1299")).toBe(129_900);
    expect(toPaise("1299.5")).toBe(129_950);
  });

  it("rounds half-paise up (never truncates)", () => {
    expect(toPaise(0.005)).toBe(1); // 0.5 paise → 1
    expect(toPaise(0.004)).toBe(0); // 0.4 paise → 0
    expect(toPaise(9.995)).toBe(1000); // 999.5 paise → 1000 (float-error regression)
    expect(toPaise(1.005)).toBe(101); // 100.5 paise → 101
    expect(toPaise("9.995")).toBe(1000);
  });

  it("rejects missing, unparseable, non-finite, and negative money", () => {
    expect(() => toPaise(null)).toThrow();
    expect(() => toPaise(undefined)).toThrow();
    expect(() => toPaise("")).toThrow();
    expect(() => toPaise("not-a-price")).toThrow();
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toPaise(-5)).toThrow(/negative/);
    // A signed string must not lose its sign during symbol stripping.
    expect(() => toPaise("-5")).toThrow(/negative/);
    expect(() => toPaise("₹-1,299")).toThrow(/negative/);
  });
});

describe("normalizeCategory", () => {
  it("maps vendor categories into our three buckets", () => {
    expect(normalizeCategory("Electronics")).toBe("electronics");
    expect(normalizeCategory("Kitchen Appliances")).toBe("home");
    expect(normalizeCategory("Footwear")).toBe("fashion");
  });

  it("rejects an unrecognized or missing category instead of guessing", () => {
    expect(() => normalizeCategory("mystery aisle")).toThrow(/unrecognized/);
    expect(() => normalizeCategory(null)).toThrow(/unrecognized/);
  });
});

describe("normalizeProduct", () => {
  it("produces a schema-valid record stamped with source and fetchedAt", () => {
    const product = normalizeProduct(raw(), options);

    expect(productSchema.safeParse(product).success).toBe(true);
    expect(product.source).toBe("live");
    expect(product.fetchedAt).toBe(options.fetchedAt);
    expect(product.price).toBe(129_950);
    expect(product.mrp).toBe(159_900);
  });

  it("requires a model number or an EAN — title alone is never enough", () => {
    expect(() =>
      normalizeProduct(raw({ modelNumber: undefined, ean: undefined }), options),
    ).toThrow(/neither a model number nor an EAN/);
  });

  it("uses the EAN as the fallback identifier for EAN-only records", () => {
    const product = normalizeProduct(
      raw({ modelNumber: undefined, ean: "8806084935120" }),
      options,
    );
    expect(product.ean).toBe("8806084935120");
    expect(product.modelNumber).toBe("ean:8806084935120");
  });

  it("rejects a malformed EAN", () => {
    expect(() => normalizeProduct(raw({ ean: "123" }), options)).toThrow(/malformed EAN/);
  });

  it("does not fabricate an MRP/discount when the source reports none", () => {
    const product = normalizeProduct(raw({ mrp: undefined }), options);
    expect(product.mrp).toBe(product.price);
  });

  it("rejects an MRP below the selling price", () => {
    expect(() => normalizeProduct(raw({ mrp: 1000 }), options)).toThrow(/MRP below/);
  });

  it("requires an https product URL", () => {
    expect(() =>
      normalizeProduct(raw({ url: "http://example.com/p/1" }), options),
    ).toThrow(/non-https/);
    expect(() => normalizeProduct(raw({ url: "" }), options)).toThrow(/non-https/);
  });

  it("clamps/rounds rating and rating count into valid ranges", () => {
    expect(normalizeProduct(raw({ rating: 9 }), options).rating).toBe(5);
    expect(normalizeProduct(raw({ rating: -3 }), options).rating).toBe(0);
    expect(normalizeProduct(raw({ rating: 4.26 }), options).rating).toBe(4.3);
    expect(normalizeProduct(raw({ rating: null }), options).rating).toBe(0);
    expect(normalizeProduct(raw({ ratingCount: -5 }), options).ratingCount).toBe(0);
    expect(normalizeProduct(raw({ ratingCount: 100.6 }), options).ratingCount).toBe(101);
  });

  it("fills safe, non-invented defaults for optional display fields", () => {
    const product = normalizeProduct(
      raw({
        brand: "",
        sellerName: "",
        deliveryEstimate: "",
        isOfficialStore: null,
        inStock: null,
        imageUrl: undefined,
      }),
      options,
    );

    expect(product.brand).toBe("Test"); // first token of the title
    expect(product.sellerName).toBe("Unknown seller");
    expect(product.deliveryEstimate).toBe("Delivery estimate unavailable");
    expect(product.isOfficialStore).toBe(false);
    expect(product.inStock).toBe(true); // only an explicit false marks it out of stock
    expect(product.imageUrl).toBe("https://cdn.shoppilot.local/products/live-p-1.jpg");
  });
});

describe("normalizeProducts", () => {
  it("skips untrustworthy records but keeps the valid ones", () => {
    const raws: RawProduct[] = [
      raw({ id: "good" }),
      raw({ id: "no-identity", modelNumber: undefined, ean: undefined }),
      raw({ id: "bad-url", url: "http://insecure.example/p" }),
      raw({ id: "good-2", modelNumber: "TM-200" }),
    ];

    const products = normalizeProducts(raws, options);

    expect(products.map((p) => p.id)).toEqual(["good", "good-2"]);
    for (const product of products) {
      expect(productSchema.safeParse(product).success).toBe(true);
    }
  });

  it("returns an empty array when every record is bad", () => {
    expect(normalizeProducts([], options)).toEqual([]);
    expect(
      normalizeProducts([raw({ modelNumber: undefined, ean: undefined })], options),
    ).toEqual([]);
  });
});
