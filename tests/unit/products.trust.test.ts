import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRUST_POLICY,
  evaluateTrust,
  filterTrusted,
  rankByTrust,
  sellerKindLabel,
  trustPolicySchema,
} from "@/modules/products/trust";
import { MOCK_PRODUCTS } from "@/modules/products/sources/mock.data";
import type { Product } from "@/modules/products/types";

/**
 * Seller-trust tests — thresholds are CODE, never the LLM's opinion.
 *
 * Fixtures used (from mock.data.ts):
 *  - el-mon-001  official, 4.5 / 2841   → passes everything
 *  - el-ms-002   third party, 4.0 / 412 → exactly at the default bar
 *  - el-hp-002   third party, 3.9 / 2103→ below the rating bar
 *  - hm-lmp-001  third party, 3.8 / 41  → below BOTH bars
 *  - hm-tab-001  official, 3.6 / 743    → numerically weak, official bypass
 */

const byId = (id: string): Product => {
  const found = MOCK_PRODUCTS.find((p) => p.id === id);
  if (!found) throw new Error(`fixture ${id} not found`);
  return found;
};

describe("trustPolicySchema", () => {
  it("defaults to min rating 4.0 and 50 ratings", () => {
    expect(DEFAULT_TRUST_POLICY).toEqual({
      minRating: 4.0,
      minRatingCount: 50,
      officialBypass: true,
    });
  });

  it("rejects a rating outside 0–5", () => {
    expect(() => trustPolicySchema.parse({ minRating: 5.5 })).toThrow();
    expect(() => trustPolicySchema.parse({ minRating: -1 })).toThrow();
  });

  it("rejects a negative rating count", () => {
    expect(() => trustPolicySchema.parse({ minRatingCount: -1 })).toThrow();
  });
});

describe("evaluateTrust", () => {
  it("trusts a well-rated official store", () => {
    const verdict = evaluateTrust(byId("el-mon-001"));
    expect(verdict).toEqual({ trusted: true, sellerKind: "official_store", reasons: [] });
  });

  it("trusts a third-party listing exactly at the bar", () => {
    const verdict = evaluateTrust(byId("el-ms-002")); // 4.0 / 412
    expect(verdict.trusted).toBe(true);
    expect(verdict.sellerKind).toBe("third_party");
  });

  it("rejects a third-party listing below the rating bar", () => {
    const verdict = evaluateTrust(byId("el-hp-002")); // 3.9
    expect(verdict.trusted).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/below the minimum/);
  });

  it("rejects a third-party listing below BOTH bars, with both reasons", () => {
    const verdict = evaluateTrust(byId("hm-lmp-001")); // 3.8 / 41
    expect(verdict.trusted).toBe(false);
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons.join(" ")).toMatch(/minimum is 50/);
  });

  it("lets an official store bypass the numeric thresholds by default", () => {
    const verdict = evaluateTrust(byId("hm-tab-001")); // official, 3.6
    expect(verdict.reasons.length).toBeGreaterThan(0); // still reported…
    expect(verdict.trusted).toBe(true); // …but official bypass keeps it trusted
    expect(verdict.sellerKind).toBe("official_store");
  });

  it("does NOT bypass when officialBypass is off", () => {
    const policy = trustPolicySchema.parse({ officialBypass: false });
    const verdict = evaluateTrust(byId("hm-tab-001"), policy);
    expect(verdict.trusted).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("applies a stricter policy when configured", () => {
    const strict = trustPolicySchema.parse({ minRating: 4.5, minRatingCount: 1000 });
    expect(evaluateTrust(byId("el-mon-001"), strict).trusted).toBe(true); // 4.5 / 2841
    expect(evaluateTrust(byId("el-hp-003"), strict).trusted).toBe(true); // 4.6 / 9120
    expect(evaluateTrust(byId("el-ms-002"), strict).trusted).toBe(false); // 4.0 / 412
  });
});

describe("filterTrusted", () => {
  const policy = DEFAULT_TRUST_POLICY;

  it("drops untrusted third-party listings", () => {
    const input = [byId("el-mon-001"), byId("hm-lmp-001"), byId("el-hp-002")];
    const out = filterTrusted(input, policy);
    expect(out.map((p) => p.id)).toEqual(["el-mon-001"]);
  });

  it("keeps official stores that only missed the numeric bar (default)", () => {
    const input = [byId("hm-tab-001")];
    expect(filterTrusted(input, policy)).toHaveLength(1);
  });

  it("drops those official stores when keepOfficial is false", () => {
    const input = [byId("hm-tab-001")];
    expect(filterTrusted(input, policy, { keepOfficial: false })).toHaveLength(0);
  });

  it("never changes the input array", () => {
    const input = [byId("hm-lmp-001"), byId("el-mon-001")];
    filterTrusted(input, policy);
    expect(input).toHaveLength(2);
  });

  it("keeps every listing when the policy is fully permissive", () => {
    const lax = trustPolicySchema.parse({ minRating: 0, minRatingCount: 0 });
    expect(filterTrusted(MOCK_PRODUCTS, lax)).toHaveLength(MOCK_PRODUCTS.length);
  });
});

describe("rankByTrust", () => {
  it("puts official stores before third-party sellers", () => {
    const ranked = rankByTrust([byId("el-hp-002"), byId("el-mon-001")]);
    expect(ranked[0]!.id).toBe("el-mon-001");
  });

  it("among third-party sellers, trusted listings come first", () => {
    const ranked = rankByTrust([byId("hm-lmp-001"), byId("el-ms-002")]);
    expect(ranked[0]!.id).toBe("el-ms-002");
  });

  it("is a total order — same input, same output, no mutation", () => {
    const input = [...MOCK_PRODUCTS];
    const a = rankByTrust(input);
    const b = rankByTrust([...MOCK_PRODUCTS].reverse());
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(input.map((p) => p.id)).toEqual(MOCK_PRODUCTS.map((p) => p.id));
  });

  it("breaks full ties deterministically on id", () => {
    const base = byId("el-ms-002");
    const twin: Product = { ...base, id: "twin", price: base.price, rating: base.rating };
    const ranked = rankByTrust([twin, base]);
    expect(ranked.map((p) => p.id)).toEqual(["el-ms-002", "twin"]);
  });
});

describe("sellerKindLabel", () => {
  it("labels an official store", () => {
    expect(sellerKindLabel(byId("el-mon-001"))).toBe("Official store");
  });

  it("labels a third-party seller (never hidden)", () => {
    expect(sellerKindLabel(byId("el-hp-002"))).toBe("Third-party seller");
  });
});
