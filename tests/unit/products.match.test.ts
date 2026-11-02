import { describe, it, expect } from "vitest";
import {
  areSameProduct,
  compareProducts,
  findMatchingListings,
  groupByProduct,
  identityKeys,
  normalizeEan,
  normalizeModelNumber,
  pickBestListing,
  primaryIdentityKey,
} from "@/modules/products/match";
import { MOCK_PRODUCTS } from "@/modules/products/sources/mock.data";
import type { Product } from "@/modules/products/types";

/**
 * Product-identity tests.
 *
 * THE RULE under test: two listings are the same real product only via a
 * shared model number or EAN — NEVER a shared title. Variants (27" vs 24"
 * monitors, different keyboard revisions) must stay in separate groups.
 */

const byId = (id: string): Product => {
  const found = MOCK_PRODUCTS.find((p) => p.id === id);
  if (!found) throw new Error(`fixture ${id} not found`);
  return found;
};

const monitor27Official = byId("el-mon-001"); // LG 27UL650-W, EAN 8806084935120
const monitor27Renewed = byId("el-mon-002"); // same EAN, different title/seller
const monitor24 = byId("el-mon-003"); // different model + EAN (variant)
const keyboardOfficial = byId("el-kb-001"); // "G413-SE" + EAN
const keyboardThirdParty = byId("el-kb-002"); // "G413SE", NO EAN (model only)

describe("normalizeModelNumber", () => {
  it("uppercases and strips every non-alphanumeric character", () => {
    expect(normalizeModelNumber("G502-HERO")).toBe("G502HERO");
    expect(normalizeModelNumber("27UL650-W")).toBe("27UL650W");
    expect(normalizeModelNumber("wh-1000xm4")).toBe("WH1000XM4");
  });

  it("makes differently-punctuated codes compare equal", () => {
    expect(normalizeModelNumber("G413-SE")).toBe(normalizeModelNumber("G413SE"));
  });
});

describe("normalizeEan", () => {
  it("keeps digits only", () => {
    expect(normalizeEan("8806084935120")).toBe("8806084935120");
    expect(normalizeEan("88060-84935120 ")).toBe("8806084935120");
  });
});

describe("identityKeys", () => {
  it("lists the EAN first (strongest key), then the model number", () => {
    expect(identityKeys(monitor27Official)).toEqual([
      "ean:8806084935120",
      "model:27UL650W",
    ]);
  });

  it("keys an EAN-only record by EAN alone (the synthetic model is not a key)", () => {
    const eanOnly: Product = {
      ...monitor24,
      ean: "8806090777123",
      modelNumber: "ean:8806090777123",
    };
    expect(identityKeys(eanOnly)).toEqual(["ean:8806090777123"]);
  });

  it("falls back to the model number when there is no EAN", () => {
    expect(identityKeys(keyboardThirdParty)).toEqual(["model:G413SE"]);
  });

  it("primaryIdentityKey prefers the EAN when present", () => {
    expect(primaryIdentityKey(monitor27Official)).toBe("ean:8806084935120");
    expect(primaryIdentityKey(keyboardThirdParty)).toBe("model:G413SE");
  });
});

describe("areSameProduct — identifier-based, never title-based", () => {
  it("matches two listings sharing an EAN despite different titles", () => {
    expect(monitor27Official.title).not.toBe(monitor27Renewed.title);
    expect(areSameProduct(monitor27Official, monitor27Renewed)).toBe(true);
  });

  it("matches two listings sharing only a normalized model number", () => {
    expect(keyboardThirdParty.ean).toBeUndefined();
    expect(areSameProduct(keyboardOfficial, keyboardThirdParty)).toBe(true);
  });

  it("does NOT match different variants that look alike", () => {
    expect(areSameProduct(monitor27Official, monitor24)).toBe(false);
  });

  it("is reflexive for the same source record", () => {
    expect(areSameProduct(monitor27Official, monitor27Official)).toBe(true);
  });

  it("is symmetric", () => {
    expect(areSameProduct(monitor27Renewed, monitor27Official)).toBe(true);
    expect(areSameProduct(monitor24, monitor27Official)).toBe(false);
  });

  it("never matches on a shared title alone", () => {
    const a = monitor27Official;
    const b: Product = { ...monitor24, title: a.title, ean: undefined }; // same title, other identifiers
    expect(areSameProduct(a, b)).toBe(false);
  });

  it("never matches two records with no identifiers at all", () => {
    const a: Product = { ...monitor24, ean: undefined, modelNumber: "" };
    const b: Product = { ...monitor24, id: "other", ean: undefined, modelNumber: "" };
    expect(areSameProduct(a, b)).toBe(false);
  });
});

describe("groupByProduct (union-find)", () => {
  it("collapses the shared-EAN pair into one group", () => {
    const groups = groupByProduct([monitor27Official, monitor27Renewed]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("keeps variants in separate groups", () => {
    const groups = groupByProduct([monitor27Official, monitor24]);
    expect(groups).toHaveLength(2);
  });

  it("merges a bridging listing that shares keys with two others", () => {
    // c shares the model with a and the EAN with b → all three are one product.
    const a: Product = { ...monitor24, id: "a", modelNumber: "X1", ean: undefined };
    const b: Product = { ...monitor24, id: "b", modelNumber: "Y1", ean: "12345678" };
    const c: Product = { ...monitor24, id: "c", modelNumber: "X1", ean: "12345678" };

    const groups = groupByProduct([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("orders a group: official store first, then in stock, then cheapest", () => {
    const groups = groupByProduct([monitor27Renewed, monitor27Official]);
    expect(groups[0]!.map((p) => p.id)).toEqual(["el-mon-001", "el-mon-002"]);
  });

  it("partitions the whole fixture catalog into distinct products", () => {
    const groups = groupByProduct(MOCK_PRODUCTS);
    const flattened = groups.flat();
    // Nothing lost, nothing duplicated.
    expect(flattened).toHaveLength(MOCK_PRODUCTS.length);
    expect(groups.length).toBeLessThan(MOCK_PRODUCTS.length);
    // The known duplicate pair is collapsed.
    const pair = groups.find((g) => g.some((p) => p.id === "el-mon-001"));
    expect(pair!.some((p) => p.id === "el-mon-002")).toBe(true);
  });

  it("is deterministic: input order never changes the partition", () => {
    const shuffled = [...MOCK_PRODUCTS].reverse();
    const partition = (groups: Product[][]): string[][] =>
      groups.map((g) => g.map((p) => p.id).sort()).sort();
    expect(partition(groupByProduct(shuffled))).toEqual(
      partition(groupByProduct(MOCK_PRODUCTS)),
    );
  });
});

describe("pickBestListing", () => {
  it("prefers the official store over a cheaper third-party listing", () => {
    const best = pickBestListing([monitor27Renewed, monitor27Official]);
    expect(best.id).toBe("el-mon-001"); // official, even though it costs more
  });

  it("prefers an in-stock listing over an out-of-stock one", () => {
    const outOfStock: Product = {
      ...monitor27Official,
      id: "x",
      isOfficialStore: false,
      inStock: false,
    };
    const inStock: Product = { ...monitor27Renewed, id: "y", isOfficialStore: false };
    expect(pickBestListing([outOfStock, inStock]).id).toBe("y");
  });

  it("falls back to the cheapest when both are equal trust/stock", () => {
    const a: Product = { ...monitor24, id: "a", price: 200_00 };
    const b: Product = { ...monitor24, id: "b", price: 100_00 };
    expect(pickBestListing([a, b]).id).toBe("b");
  });

  it("throws on an empty group rather than inventing a product", () => {
    expect(() => pickBestListing([])).toThrow();
  });
});

describe("compareProducts — one row per distinct product", () => {
  it("emits a single row for two listings of the same product", () => {
    const rows = compareProducts([monitor27Official, monitor27Renewed]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.listings).toHaveLength(2);
    expect(rows[0]!.best.id).toBe("el-mon-001");
  });

  it("emits separate rows for variants", () => {
    const rows = compareProducts([monitor27Official, monitor24]);
    expect(rows).toHaveLength(2);
  });

  it("sorts rows cheapest-first", () => {
    const rows = compareProducts([monitor27Official, monitor24, keyboardThirdParty]);
    const prices = rows.map((r) => r.best.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("gives every row a stable identity key", () => {
    const rows = compareProducts([monitor27Official, monitor24]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("findMatchingListings", () => {
  it("returns the other listings of the same product (excluding itself)", () => {
    const matches = findMatchingListings(MOCK_PRODUCTS, monitor27Official);
    expect(matches.map((p) => p.id)).toContain("el-mon-002");
    expect(matches.map((p) => p.id)).not.toContain("el-mon-001");
    expect(matches.map((p) => p.id)).not.toContain("el-mon-003");
  });
});
