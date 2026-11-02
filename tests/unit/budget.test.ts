import { describe, it, expect } from "vitest";
import {
  cartLineSchema,
  computeBudget,
  computeSubtotal,
  formatInr,
  isWithinBudget,
  lineTotalPaise,
  linesByCostDesc,
  remainingPaise,
  taxFromRate,
  type CartLine,
} from "@/modules/budget";

/**
 * Budget engine tests — the gate for Phase 3.
 *
 * Money is integer paise everywhere; the whole point of this module is that it
 * NEVER invents a number. These tests pin down: rounding, known vs unknown
 * costs, over-budget behaviour, zero items, and the input validation that
 * keeps floats/negatives out of a total.
 */

const line = (overrides: Partial<CartLine> = {}): CartLine => ({
  productId: "p-1",
  title: "Test product",
  quantity: 1,
  unitPricePaise: 100_00,
  ...overrides,
});

describe("lineTotalPaise / computeSubtotal", () => {
  it("multiplies unit price by quantity in integer paise", () => {
    expect(lineTotalPaise(line({ unitPricePaise: 250_50, quantity: 3 }))).toBe(751_50);
  });

  it("a single unit costs exactly its unit price", () => {
    expect(lineTotalPaise(line({ unitPricePaise: 999 }))).toBe(999);
  });

  it("sums every line", () => {
    const lines = [
      line({ productId: "a", unitPricePaise: 100_00, quantity: 2 }),
      line({ productId: "b", unitPricePaise: 50_00 }),
    ];
    expect(computeSubtotal(lines)).toBe(250_00);
  });

  it("zero items → subtotal of 0", () => {
    expect(computeSubtotal([])).toBe(0);
  });

  it("rejects a fractional-paise line (floats never reach a total)", () => {
    expect(() => lineTotalPaise(line({ unitPricePaise: 100.5 }))).toThrow();
  });
});

describe("taxFromRate — half-up rounding on the paise", () => {
  it("rounds .95 paise UP to the next paise (5% of ₹9.99)", () => {
    // 999 paise × 5% = 49.95 paise → 50
    expect(taxFromRate(999, 5)).toBe(50);
  });

  it("rounds .5 paise up (half-up, not banker's rounding)", () => {
    // 10 paise × 5% = 0.5 paise → 1
    expect(taxFromRate(10, 5)).toBe(1);
  });

  it("returns 0 for a 0% rate", () => {
    expect(taxFromRate(100_000, 0)).toBe(0);
  });

  it("returns the full amount at 100%", () => {
    expect(taxFromRate(100_000, 100)).toBe(100_000);
  });

  it("rejects a fractional subtotal", () => {
    expect(() => taxFromRate(100.5, 18)).toThrow();
  });

  it("rejects rates outside 0–100", () => {
    expect(() => taxFromRate(100, -1)).toThrow();
    expect(() => taxFromRate(100, 101)).toThrow();
  });
});

describe("computeBudget — known costs", () => {
  it("computes subtotal + known shipping + known tax", () => {
    const result = computeBudget({
      budgetPaise: 500_00,
      lines: [
        line({
          productId: "a",
          unitPricePaise: 100_00,
          quantity: 2,
          shippingPaise: 40_00,
          taxPaise: 18_00,
        }),
        line({
          productId: "b",
          unitPricePaise: 50_00,
          shippingPaise: 20_00,
          taxPaise: 9_00,
        }),
      ],
    });

    expect(result.subtotalPaise).toBe(250_00);
    expect(result.shippingPaise).toBe(60_00);
    expect(result.taxPaise).toBe(27_00);
    expect(result.totalPaise).toBe(337_00);
    expect(result.remainingPaise).toBe(163_00);
    expect(result.overagePaise).toBe(0);
    expect(result.withinBudget).toBe(true);
    expect(result.hasUnknownCosts).toBe(false);
  });

  it("applies a flat cart-level shipping charge when lines stay silent", () => {
    const result = computeBudget({
      budgetPaise: 100_00,
      lines: [line({ unitPricePaise: 90_00 })],
      flatShippingPaise: 5_00,
    });

    expect(result.shippingPaise).toBe(5_00);
    expect(result.shippingKnown).toBe(true);
    expect(result.totalPaise).toBe(95_00);
    // Known costs fit, but tax is still unknown — so the module must not claim
    // a firm "within budget" (matches the unknown-cost invariant below).
    expect(result.fitsKnownBudget).toBe(true);
    expect(result.withinBudget).toBe(false);
    expect(result.unknownCosts).toEqual({ shipping: false, tax: true });
  });

  it("derives tax from a rate when lines carry no tax", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [line({ unitPricePaise: 100_00 })],
      taxRatePercent: 18,
    });

    expect(result.taxPaise).toBe(18_00);
    expect(result.taxKnown).toBe(true);
    expect(result.totalPaise).toBe(118_00);
  });

  it("uses line-level tax over the rate (explicit beats derived)", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [line({ unitPricePaise: 100_00, taxPaise: 5_00 })],
      taxRatePercent: 18,
    });

    expect(result.taxPaise).toBe(5_00);
  });
});

describe("computeBudget — unknown costs are flagged, never guessed", () => {
  it("flags unknown shipping when no line and no flat rule say otherwise", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [line({ unitPricePaise: 100_00, taxPaise: 18_00 })],
    });

    expect(result.shippingKnown).toBe(false);
    expect(result.unknownCosts).toEqual({ shipping: true, tax: false });
    expect(result.hasUnknownCosts).toBe(true);
    // The unknown shipping contributes 0 to the total — it is NOT assumed free.
    expect(result.totalPaise).toBe(118_00);
  });

  it("flags unknown tax when neither lines nor a rate say otherwise", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [line({ unitPricePaise: 100_00, shippingPaise: 0 })],
    });

    expect(result.taxKnown).toBe(false);
    expect(result.unknownCosts).toEqual({ shipping: false, tax: true });
    expect(result.hasUnknownCosts).toBe(true);
  });

  it("partial knowledge: only the missing cost is flagged", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [
        line({ productId: "a", unitPricePaise: 100_00, shippingPaise: 10_00 }),
        line({ productId: "b", unitPricePaise: 100_00 }), // shipping unknown
      ],
    });

    expect(result.shippingKnown).toBe(false);
    expect(result.taxKnown).toBe(false);
    expect(result.unknownCosts).toEqual({ shipping: true, tax: true });
    // Only the known shipping amount is counted.
    expect(result.shippingPaise).toBe(10_00);
  });

  it("never claims `withinBudget` while any cost is unknown — even if it fits", () => {
    const result = computeBudget({
      budgetPaise: 1_000_00,
      lines: [line({ unitPricePaise: 100_00 })],
    });

    expect(result.fitsKnownBudget).toBe(true);
    expect(result.withinBudget).toBe(false);
    expect(isWithinBudget(result)).toBe(false);
  });
});

describe("computeBudget — over budget (honest failure)", () => {
  it("reports a negative remaining and a positive overage", () => {
    const result = computeBudget({
      budgetPaise: 100_00,
      lines: [line({ unitPricePaise: 150_00, shippingPaise: 0, taxPaise: 0 })],
    });

    expect(result.totalPaise).toBe(150_00);
    expect(result.remainingPaise).toBe(-50_00);
    expect(remainingPaise(result)).toBe(-50_00);
    expect(result.overagePaise).toBe(50_00);
    expect(result.fitsKnownBudget).toBe(false);
    expect(result.withinBudget).toBe(false);
  });

  it("overage is exactly 0 when the cart lands on the budget", () => {
    const result = computeBudget({
      budgetPaise: 100_00,
      lines: [line({ unitPricePaise: 100_00, shippingPaise: 0, taxPaise: 0 })],
    });

    expect(result.remainingPaise).toBe(0);
    expect(result.overagePaise).toBe(0);
    expect(result.fitsKnownBudget).toBe(true);
    expect(result.withinBudget).toBe(true);
  });

  it("an unknown cost cannot rescue an over-budget cart", () => {
    const result = computeBudget({
      budgetPaise: 100_00,
      lines: [line({ unitPricePaise: 120_00 })],
    });

    expect(result.fitsKnownBudget).toBe(false);
    expect(result.withinBudget).toBe(false);
  });
});

describe("computeBudget — zero items", () => {
  it("an empty cart costs nothing and is trivially within budget", () => {
    const result = computeBudget({ budgetPaise: 500_00, lines: [] });

    expect(result.lineCount).toBe(0);
    expect(result.subtotalPaise).toBe(0);
    expect(result.shippingPaise).toBe(0);
    expect(result.taxPaise).toBe(0);
    expect(result.totalPaise).toBe(0);
    expect(result.remainingPaise).toBe(500_00);
    expect(result.hasUnknownCosts).toBe(false); // nothing to ship, nothing to tax
    expect(result.withinBudget).toBe(true);
  });

  it("an empty cart with a flat shipping rule still charges that rule", () => {
    const result = computeBudget({
      budgetPaise: 500_00,
      lines: [],
      flatShippingPaise: 40_00,
    });

    expect(result.shippingPaise).toBe(40_00);
    expect(result.shippingKnown).toBe(true);
    expect(result.totalPaise).toBe(40_00);
  });
});

describe("computeBudget — input validation (Zod)", () => {
  it("rejects a fractional budget", () => {
    expect(() => computeBudget({ budgetPaise: 100.5, lines: [] })).toThrow();
  });

  it("rejects a zero or negative budget", () => {
    expect(() => computeBudget({ budgetPaise: 0, lines: [] })).toThrow();
    expect(() => computeBudget({ budgetPaise: -1, lines: [] })).toThrow();
  });

  it("rejects negative money", () => {
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line({ unitPricePaise: -1 })] }),
    ).toThrow();
  });

  it("rejects quantity outside 1–99", () => {
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line({ quantity: 0 })] }),
    ).toThrow();
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line({ quantity: 100 })] }),
    ).toThrow();
  });

  it("rejects a missing productId or title", () => {
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line({ productId: "" })] }),
    ).toThrow();
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line({ title: "" })] }),
    ).toThrow();
  });

  it("rejects a negative flat shipping charge", () => {
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [], flatShippingPaise: -1 }),
    ).toThrow();
  });

  it("rejects a tax rate above 100%", () => {
    expect(() =>
      computeBudget({ budgetPaise: 100_00, lines: [line()], taxRatePercent: 101 }),
    ).toThrow();
  });
});

describe("cartLineSchema", () => {
  it("accepts a minimal valid line", () => {
    expect(() => cartLineSchema.parse(line())).not.toThrow();
  });

  it("allows shipping/tax to be explicitly null (known-unknown)", () => {
    const parsed = cartLineSchema.parse(line({ shippingPaise: null, taxPaise: null }));
    expect(parsed.shippingPaise).toBeNull();
    expect(parsed.taxPaise).toBeNull();
  });
});

describe("linesByCostDesc — honest-failure helper", () => {
  it("orders by line total, most expensive first", () => {
    const lines = [
      line({ productId: "cheap", unitPricePaise: 10_00, quantity: 1 }),
      line({ productId: "pricey", unitPricePaise: 90_00, quantity: 2 }),
      line({ productId: "mid", unitPricePaise: 50_00, quantity: 1 }),
    ];

    expect(linesByCostDesc(lines).map((l) => l.productId)).toEqual([
      "pricey",
      "mid",
      "cheap",
    ]);
  });

  it("breaks ties on productId so the order is deterministic", () => {
    const lines = [
      line({ productId: "b", unitPricePaise: 50_00 }),
      line({ productId: "a", unitPricePaise: 50_00 }),
    ];

    expect(linesByCostDesc(lines).map((l) => l.productId)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const lines = [
      line({ productId: "a", unitPricePaise: 10_00 }),
      line({ productId: "b", unitPricePaise: 90_00 }),
    ];
    const copy = [...lines];
    linesByCostDesc(lines);
    expect(lines).toEqual(copy);
  });
});

describe("formatInr — display only, math stays in paise", () => {
  it("formats whole rupees with grouping", () => {
    expect(formatInr(129_900)).toBe("₹1,299.00");
    expect(formatInr(1_000_00)).toBe("₹1,000.00");
  });

  it("keeps two decimal places for paise", () => {
    expect(formatInr(5)).toBe("₹0.05");
    expect(formatInr(999)).toBe("₹9.99");
  });

  it("formats zero", () => {
    expect(formatInr(0)).toBe("₹0.00");
  });

  it("formats negative amounts with a leading minus", () => {
    expect(formatInr(-50_00)).toBe("-₹50.00");
  });

  it("rejects fractional paise", () => {
    expect(() => formatInr(10.5)).toThrow();
  });
});
