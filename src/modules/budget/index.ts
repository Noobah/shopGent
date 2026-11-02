import { z } from "zod";
import { ValidationError } from "@/lib/errors";

/**
 * budget/ — the ONLY place money math happens.
 *
 * Pure functions over integer paise (INR). The LLM never computes a total; the
 * agent calls `computeBudget()` and reports what it returns. Rules:
 *
 *  - every number is an integer number of paise — no floats reach a total
 *  - shipping/tax are reported only when KNOWN; unknown costs are flagged, and
 *    never replaced by an estimate (that would be inventing numbers)
 *  - `totalPaise` is therefore the KNOWN total; `withinBudget` requires both a
 *    fit AND no unknown costs, so we can't claim a cart fits when it might not
 *
 * No I/O, no clock, no LLM — this is the module the handoff bill must agree
 * with exactly (Phase 6 asserts bill totals === these totals).
 */

// ---- input schemas (Zod) -------------------------------------------------

/** Non-negative integer paise. */
export const paiseFieldSchema = z
  .number()
  .int("money must be an integer number of paise")
  .min(0, "money cannot be negative");

export const quantitySchema = z
  .number()
  .int("quantity must be an integer")
  .min(1, "quantity must be at least 1")
  .max(99, "quantity cannot exceed 99");

/**
 * One cart line.
 *
 * `shippingPaise`/`taxPaise` semantics:
 *  - number  → known amount for this line
 *  - null    → explicitly unknown (source said "calculated at checkout")
 *  - omitted → unknown (we do not assume free)
 */
export const cartLineSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  quantity: quantitySchema,
  unitPricePaise: paiseFieldSchema,
  shippingPaise: z.number().int().min(0).nullable().optional(),
  taxPaise: z.number().int().min(0).nullable().optional(),
});

export type CartLine = z.infer<typeof cartLineSchema>;

export const budgetInputSchema = z.object({
  /** The user's stated budget, in integer paise. Must be a positive amount. */
  budgetPaise: z
    .number()
    .int("budget must be an integer number of paise")
    .positive("budget must be greater than zero"),
  lines: z.array(cartLineSchema).max(100),
  /**
   * Optional cart-level shipping rule: a flat charge applied to the cart when
   * no line reports its own shipping. `null` = unknown (default behaviour).
   */
  flatShippingPaise: z.number().int().min(0).nullable().optional(),
  /**
   * Optional tax rate (e.g. 18) applied to the subtotal when lines don't carry
   * their own tax. Omit → tax is unknown, never guessed.
   */
  taxRatePercent: z.number().min(0).max(100).optional(),
});

export type BudgetInput = z.infer<typeof budgetInputSchema>;

// ---- result --------------------------------------------------------------

export interface BudgetResult {
  budgetPaise: number;
  lineCount: number;
  /** Sum of unitPrice × quantity. Always known. */
  subtotalPaise: number;
  /** Known shipping only; see `shippingKnown`. */
  shippingPaise: number;
  /** True when EVERY line's shipping amount (or the flat rule) is known. */
  shippingKnown: boolean;
  /** Known tax only; see `taxKnown`. */
  taxPaise: number;
  taxKnown: boolean;
  /** subtotal + known shipping + known tax. */
  totalPaise: number;
  /** budget − totalPaise. Negative when over budget. */
  remainingPaise: number;
  /** How far over budget (0 when within). */
  overagePaise: number;
  /** Known costs fit inside the budget. */
  fitsKnownBudget: boolean;
  /** Known costs fit AND nothing is unknown — safe to say "within budget". */
  withinBudget: boolean;
  /** True when any cost is unknown (shipping or tax). */
  hasUnknownCosts: boolean;
  /** Which costs are unknown — displayed as "unknown", never estimated. */
  unknownCosts: { shipping: boolean; tax: boolean };
}

// ---- pure math -----------------------------------------------------------

/** Integer line total. Throws if the line isn't already schema-valid. */
export function lineTotalPaise(line: CartLine): number {
  const parsed = cartLineSchema.parse(line);
  return parsed.unitPricePaise * parsed.quantity;
}

/** Sum of all line totals. Zero items → 0. */
export function computeSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalPaise(line), 0);
}

/**
 * Tax from a rate, in integer paise, half-up on the paise (e.g. 5% of ₹9.99 =
 * 49.95 paise → 50). Pure and explicit — this is the rounding the gate tests.
 */
export function taxFromRate(subtotalPaise: number, ratePercent: number): number {
  if (!Number.isInteger(subtotalPaise)) {
    throw new ValidationError("subtotal must be integer paise");
  }
  if (ratePercent < 0 || ratePercent > 100) {
    throw new ValidationError("tax rate must be between 0 and 100 percent");
  }
  return Math.round((subtotalPaise * ratePercent) / 100);
}

/**
 * Compute the full budget picture.
 *
 * Throws `ValidationError` (via Zod) on malformed input: fractional paise,
 * negative money, quantity outside 1–99, or a non-positive budget.
 */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { budgetPaise, lines } = budgetInputSchema.parse(input);

  const subtotalPaise = computeSubtotal(lines);

  // --- shipping ---
  const lineShippingKnown = lines.map((l) =>
    typeof l.shippingPaise === "number" ? { known: true, amount: l.shippingPaise } : null,
  );
  const allLinesSpecifyShipping = lines.every((_, i) => lineShippingKnown[i] !== null);
  const linesShippingSum = lineShippingKnown.reduce<number>(
    (sum, entry) => sum + (entry?.amount ?? 0),
    0,
  );

  let shippingPaise: number;
  let shippingKnown: boolean;
  if (lines.length === 0) {
    // Nothing to ship: there is no unknown cost to flag. A flat cart-level
    // charge (rare, but configurable) still applies.
    shippingPaise =
      typeof input.flatShippingPaise === "number" ? input.flatShippingPaise : 0;
    shippingKnown = true;
  } else if (allLinesSpecifyShipping) {
    shippingPaise = linesShippingSum;
    shippingKnown = true;
  } else if (typeof input.flatShippingPaise === "number") {
    // Explicit cart-level flat charge covers the lines that didn't say.
    shippingPaise = linesShippingSum + input.flatShippingPaise;
    shippingKnown = true;
  } else {
    // Unknown → contribute nothing, but flag it. Never assume free shipping.
    shippingPaise = linesShippingSum;
    shippingKnown = false;
  }

  // --- tax ---
  const lineTaxKnown =
    lines.length > 0 && lines.every((l) => typeof l.taxPaise === "number");
  const linesTaxSum = lines.reduce<number>(
    (sum, l) => sum + (typeof l.taxPaise === "number" ? l.taxPaise : 0),
    0,
  );

  let taxPaise: number;
  let taxKnown: boolean;
  if (lines.length === 0) {
    // Empty cart → nothing is taxable; no unknown cost to flag.
    taxPaise = 0;
    taxKnown = true;
  } else if (lineTaxKnown) {
    taxPaise = linesTaxSum;
    taxKnown = true;
  } else if (input.taxRatePercent !== undefined) {
    taxPaise = linesTaxSum + taxFromRate(subtotalPaise, input.taxRatePercent);
    taxKnown = true;
  } else {
    taxPaise = linesTaxSum;
    taxKnown = false;
  }

  // --- totals ---
  const totalPaise = subtotalPaise + shippingPaise + taxPaise;
  const remainingPaise = budgetPaise - totalPaise;
  const overagePaise = remainingPaise < 0 ? -remainingPaise : 0;
  const fitsKnownBudget = remainingPaise >= 0;
  const hasUnknownCosts = !shippingKnown || !taxKnown;

  return {
    budgetPaise,
    lineCount: lines.length,
    subtotalPaise,
    shippingPaise,
    shippingKnown,
    taxPaise,
    taxKnown,
    totalPaise,
    remainingPaise,
    overagePaise,
    fitsKnownBudget,
    withinBudget: fitsKnownBudget && !hasUnknownCosts,
    hasUnknownCosts,
    unknownCosts: { shipping: !shippingKnown, tax: !taxKnown },
  };
}

/**
 * Strict fit check used by `build_handoff` gating: the cart must fit AND have
 * no unknown costs (otherwise we'd be promising a fit we can't verify).
 */
export function isWithinBudget(result: BudgetResult): boolean {
  return result.withinBudget;
}

/** Remaining budget in paise (negative when over). */
export function remainingPaise(result: BudgetResult): number {
  return result.remainingPaise;
}

/**
 * Honest-failure helper: lines ordered by how much they cost the cart, so the
 * agent can offer "drop this to get back in budget" without doing arithmetic.
 */
export function linesByCostDesc(lines: CartLine[]): CartLine[] {
  return [...lines].sort(
    (a, b) =>
      lineTotalPaise(b) - lineTotalPaise(a) || a.productId.localeCompare(b.productId),
  );
}

// ---- formatting (display only; math stays in paise) ----------------------

/**
 * Render integer paise as INR: 129900 → "₹1,299.00".
 * Locale-stable (fixed en-IN grouping) so tests and bills never drift.
 */
export function formatInr(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new ValidationError("formatInr expects integer paise");
  }
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  const grouped = String(rupees).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₹${grouped}.${fraction}`;
}
