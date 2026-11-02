import { z } from "zod";
import {
  budgetResultSchema,
  computeBudget,
  formatInr,
  paiseFieldSchema,
  type BudgetResult,
  type CartLine,
} from "@/modules/budget";
import { evaluateTrust, type Product } from "@/modules/products";
import {
  createHandoffForUser,
  replaceCartLinesForUser,
  updateChatSessionForUser,
  type CartItem,
} from "@/modules/sessions";
import { cartLineViewSchema, cartViewSchema, toCartView } from "../cart";
import { ToolError, defineTool, type ToolContext } from "./types";

/**
 * Cart, budget and handoff tools.
 *
 * This is where code ownership is strongest:
 *  - add/remove validate quantity and persist the cart immediately
 *  - check_budget reads the session budget (set by code) and computes totals in
 *    the pure budget module — the model never does arithmetic
 *  - build_handoff refuses unless the computed budget is strictly within budget
 *    with no unknown costs
 */

// ---- shared helpers ------------------------------------------------------

function toCartItem(product: Product, quantity: number): CartItem {
  return {
    productId: product.id,
    source: product.source,
    title: product.title,
    brand: product.brand,
    modelNumber: product.modelNumber,
    quantity,
    unitPricePaise: product.price,
    sellerName: product.sellerName,
    isOfficialStore: product.isOfficialStore,
    deliveryEstimate: product.deliveryEstimate,
    url: product.url,
    imageUrl: product.imageUrl,
  };
}

function toBudgetLines(items: CartItem[]): CartLine[] {
  return items.map((item) => ({
    productId: item.productId,
    title: item.title,
    quantity: item.quantity,
    unitPricePaise: item.unitPricePaise,
  }));
}

function requireBudgetPaise(context: ToolContext): number {
  const budget = context.session.budgetPaise;
  if (typeof budget !== "number" || budget <= 0) {
    throw new ToolError(
      "NO_BUDGET",
      "No budget is set for this chat. Ask the user for a budget before checking totals.",
    );
  }
  return budget;
}

function computeForContext(context: ToolContext): BudgetResult {
  const shipping = context.session.flatShippingPaise;
  const tax = context.session.taxRatePercent;

  return computeBudget({
    budgetPaise: requireBudgetPaise(context),
    lines: toBudgetLines(context.cartItems),
    // null/undefined both mean "unknown"; the budget engine flags that state.
    flatShippingPaise: typeof shipping === "number" ? shipping : null,
    taxRatePercent: typeof tax === "number" ? tax : undefined,
  });
}

function formatCost(amountPaise: number, known: boolean): string {
  return known ? formatInr(amountPaise) : "unknown";
}

function formattedBudget(budget: BudgetResult): {
  budget: string;
  subtotal: string;
  shipping: string;
  tax: string;
  knownTotal: string;
  remaining: string;
  overage: string;
} {
  return {
    budget: formatInr(budget.budgetPaise),
    subtotal: formatInr(budget.subtotalPaise),
    shipping: formatCost(budget.shippingPaise, budget.shippingKnown),
    tax: formatCost(budget.taxPaise, budget.taxKnown),
    knownTotal: formatInr(budget.totalPaise),
    remaining: formatInr(budget.remainingPaise),
    overage: formatInr(budget.overagePaise),
  };
}

async function persistCart(context: ToolContext, items: CartItem[]): Promise<CartItem[]> {
  const cart = await replaceCartLinesForUser(context.userId, context.sessionId, items);
  if (!cart) throw new ToolError("NOT_FOUND", "Chat session not found.");
  context.cartItems = items;
  return items;
}

// ---- add_to_cart ---------------------------------------------------------

const addToCartInputSchema = z.object({
  productId: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(99).optional(),
});

const addToCartOutputSchema = z.object({
  cart: cartViewSchema,
  line: cartLineViewSchema,
});

export const addToCartTool = defineTool({
  name: "add_to_cart",
  description:
    "Add a product to the authenticated user's cart, or increase its quantity. The product must exist, be in stock, and pass the seller-trust policy. Quantity defaults to 1 and is capped at 99.",
  inputSchema: addToCartInputSchema,
  outputSchema: addToCartOutputSchema,
  run: async (context, input) => {
    const quantity = input.quantity ?? 1;

    const product = await context.productSource.getById(input.productId, {
      signal: context.signal,
    });
    if (!product) {
      throw new ToolError("NOT_FOUND", `No product found with id "${input.productId}".`);
    }
    if (!product.inStock) {
      throw new ToolError("OUT_OF_STOCK", `"${product.title}" is out of stock.`);
    }

    const verdict = evaluateTrust(product, context.trustPolicy);
    if (!verdict.trusted) {
      throw new ToolError(
        "UNTRUSTED_SELLER",
        `"${product.title}" fails the seller-trust policy: ${verdict.reasons.join("; ")}.`,
      );
    }

    const existing = context.cartItems.find(
      (item) => item.productId === product.id && item.source === product.source,
    );
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (nextQuantity > 99) {
      throw new ToolError(
        "QUANTITY_LIMIT",
        `Quantity for "${product.title}" would exceed 99.`,
      );
    }

    const line = toCartItem(product, nextQuantity);
    const nextItems = existing
      ? context.cartItems.map((item) =>
          item.productId === product.id && item.source === product.source ? line : item,
        )
      : [...context.cartItems, line];

    const items = await persistCart(context, nextItems);
    const cart = toCartView(context.sessionId, items);
    const lineView = cart.lines.find((entry) => entry.productId === product.id);
    if (!lineView) {
      throw new ToolError("INTERNAL_TOOL_ERROR", "Added line disappeared from the cart.");
    }

    return {
      output: addToCartOutputSchema.parse({ cart, line: lineView }),
      cartItems: items,
    };
  },
});

// ---- remove_from_cart ----------------------------------------------------

const removeFromCartInputSchema = z.object({
  productId: z.string().trim().min(1).max(200),
  /** Omit to remove the whole line; otherwise remove this many units. */
  quantity: z.number().int().min(1).max(99).optional(),
});

const removeFromCartOutputSchema = z.object({
  cart: cartViewSchema,
  removed: z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1),
  }),
});

export const removeFromCartTool = defineTool({
  name: "remove_from_cart",
  description:
    "Remove a cart line entirely, or decrement its quantity by a specified amount. Quantity is validated against the current cart; the cart belongs to the authenticated session user.",
  inputSchema: removeFromCartInputSchema,
  outputSchema: removeFromCartOutputSchema,
  run: async (context, input) => {
    const existing = context.cartItems.find((item) => item.productId === input.productId);
    if (!existing) {
      throw new ToolError(
        "NOT_FOUND",
        `Product "${input.productId}" is not in the cart.`,
      );
    }

    const removeQuantity = input.quantity ?? existing.quantity;
    if (removeQuantity > existing.quantity) {
      throw new ToolError(
        "INVALID_QUANTITY",
        `Cannot remove ${removeQuantity}; the cart only has ${existing.quantity}.`,
      );
    }

    const remaining = existing.quantity - removeQuantity;
    const nextItems =
      remaining === 0
        ? context.cartItems.filter((item) => item.productId !== input.productId)
        : context.cartItems.map((item) =>
            item.productId === input.productId ? { ...item, quantity: remaining } : item,
          );

    const items = await persistCart(context, nextItems);
    const cart = toCartView(context.sessionId, items);

    return {
      output: removeFromCartOutputSchema.parse({
        cart,
        removed: { productId: input.productId, quantity: removeQuantity },
      }),
      cartItems: items,
    };
  },
});

// ---- check_budget --------------------------------------------------------

const checkBudgetInputSchema = z.object({
  /** Explicit cart-level shipping rule, or null to keep it unknown. */
  flatShippingPaise: paiseFieldSchema.nullable().optional(),
  /** Explicit tax rate (0-100), or null to keep it unknown. */
  taxRatePercent: z.number().min(0).max(100).nullable().optional(),
});

const checkBudgetOutputSchema = z.object({
  budget: budgetResultSchema,
  assumptions: z.object({
    flatShippingPaise: z.number().int().min(0).nullable(),
    taxRatePercent: z.number().min(0).max(100).nullable(),
  }),
  formatted: z.object({
    budget: z.string(),
    subtotal: z.string(),
    shipping: z.string(),
    tax: z.string(),
    knownTotal: z.string(),
    remaining: z.string(),
    overage: z.string(),
  }),
});

export const checkBudgetTool = defineTool({
  name: "check_budget",
  description:
    "Compute cart totals against the budget stored by code. Returns subtotal, known shipping/tax, total, remaining/overage and whether the cart is strictly within budget. Pass flatShippingPaise/taxRatePercent only when the user explicitly stated those rules; omit them when unknown. Never compute totals yourself.",
  inputSchema: checkBudgetInputSchema,
  outputSchema: checkBudgetOutputSchema,
  run: async (context, input) => {
    // Persist explicit rules so build_handoff uses the same assumptions as the
    // check the model just saw. Omitted fields keep their previous value.
    const patch: {
      flatShippingPaise?: number | null;
      taxRatePercent?: number | null;
    } = {};
    if (input.flatShippingPaise !== undefined) {
      patch.flatShippingPaise = input.flatShippingPaise;
    }
    if (input.taxRatePercent !== undefined) {
      patch.taxRatePercent = input.taxRatePercent;
    }

    if (Object.keys(patch).length > 0) {
      const updated = await updateChatSessionForUser(
        context.userId,
        context.sessionId,
        patch,
      );
      if (!updated) throw new ToolError("NOT_FOUND", "Chat session not found.");
      context.session.flatShippingPaise = updated.flatShippingPaise ?? null;
      context.session.taxRatePercent = updated.taxRatePercent ?? null;
    }

    const budget = computeForContext(context);
    const assumptions = {
      flatShippingPaise:
        typeof context.session.flatShippingPaise === "number"
          ? context.session.flatShippingPaise
          : null,
      taxRatePercent:
        typeof context.session.taxRatePercent === "number"
          ? context.session.taxRatePercent
          : null,
    };

    return {
      output: checkBudgetOutputSchema.parse({
        budget,
        assumptions,
        formatted: formattedBudget(budget),
      }),
      budget,
    };
  },
});

// ---- build_handoff -------------------------------------------------------

const buildHandoffInputSchema = z.object({});

const buildHandoffOutputSchema = z.object({
  handoffId: z.string().min(1),
  budget: budgetResultSchema,
  cart: cartViewSchema,
  formatted: z.object({
    budget: z.string(),
    subtotal: z.string(),
    shipping: z.string(),
    tax: z.string(),
    knownTotal: z.string(),
    remaining: z.string(),
    overage: z.string(),
  }),
});

export const buildHandoffTool = defineTool({
  name: "build_handoff",
  description:
    "Create the final bill snapshot and retailer links for the cart. Call ONLY after check_budget returns withinBudget=true. This tool refuses an empty cart, an over-budget cart, or a cart with unknown shipping/tax — it will not promise a fit that cannot be verified.",
  inputSchema: buildHandoffInputSchema,
  outputSchema: buildHandoffOutputSchema,
  run: async (context) => {
    if (context.cartItems.length === 0) {
      throw new ToolError("EMPTY_CART", "The cart is empty; add items first.");
    }

    const budget = computeForContext(context);
    if (!budget.fitsKnownBudget) {
      throw new ToolError(
        "OVER_BUDGET",
        `The cart is over budget by ${formatInr(budget.overagePaise)}. Remove or replace items and check again.`,
      );
    }
    if (!budget.withinBudget) {
      const unknown = [
        budget.unknownCosts.shipping ? "shipping" : null,
        budget.unknownCosts.tax ? "tax" : null,
      ]
        .filter((value): value is string => value !== null)
        .join(" and ");
      throw new ToolError(
        "UNKNOWN_COSTS",
        `${unknown} is unknown, so a within-budget handoff cannot be verified. State the missing cost rule or explain the uncertainty.`,
      );
    }

    const handoff = await createHandoffForUser(context.userId, context.sessionId, {
      status: "ready",
      budget,
      lines: context.cartItems,
      note: null,
    });

    context.session.lastHandoffId = handoff._id;
    context.session.status = "handoff_ready";
    const cart = toCartView(context.sessionId, context.cartItems);

    return {
      output: buildHandoffOutputSchema.parse({
        handoffId: handoff._id.toString(),
        budget,
        cart,
        formatted: formattedBudget(budget),
      }),
      handoff: { id: handoff._id.toString(), budget },
      budget,
    };
  },
});
