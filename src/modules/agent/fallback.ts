import { formatInr, type BudgetResult } from "@/modules/budget";
import type { Product } from "@/modules/products";
import type { CartView } from "./cart";

/**
 * Deterministic fallback answer.
 *
 * Used when the model's answer fails verification twice, or when the step cap is
 * reached before a final answer. Every number here comes from a tool result or
 * the code-owned budget — never from the model.
 */

export type FallbackReason = "step_limit" | "verification_failed";

export interface FallbackContext {
  reason: FallbackReason;
  budgetPaise: number | null;
  cart: CartView;
  budget: BudgetResult | null;
  handoffId: string | null;
  /** Most recent search results, used when the cart is still empty. */
  searchResults: Product[];
}

export function buildFallbackAnswer(context: FallbackContext): string {
  const intro =
    context.reason === "step_limit"
      ? "I reached my step limit before I could finish, so here is the verified state of your cart:"
      : "I couldn't produce an answer that passed my price verification, so here is the verified state of your cart:";

  if (context.handoffId && context.budget) {
    return [
      "Your cart is ready for handoff.",
      ...formatCartLines(context.cart),
      `Known total: ${formatInr(context.budget.totalPaise)}. Budget: ${formatInr(context.budget.budgetPaise)}. Remaining: ${formatInr(context.budget.remainingPaise)}.`,
      formatCostNote(context.budget),
      "Open the retailer links from the bill to buy.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (context.cart.lines.length > 0) {
    const lines = [
      intro,
      ...formatCartLines(context.cart),
      `Subtotal: ${formatInr(context.cart.subtotalPaise)}.`,
    ];

    if (context.budget) {
      lines.push(
        context.budget.withinBudget
          ? `The cart fits your ${formatInr(context.budget.budgetPaise)} budget with ${formatInr(context.budget.remainingPaise)} left.`
          : context.budget.hasUnknownCosts
            ? `I can't confirm the final total because ${unknownCostNames(context.budget)} is unknown.`
            : `The cart is over your ${formatInr(context.budget.budgetPaise)} budget by ${formatInr(context.budget.overagePaise)}.`,
      );
      const note = formatCostNote(context.budget);
      if (note) lines.push(note);
    } else if (context.budgetPaise !== null) {
      lines.push(
        `Your budget is ${formatInr(context.budgetPaise)}. I have not verified the final total yet.`,
      );
    }

    lines.push("Tell me which item to change and I'll continue.");
    return lines.join("\n");
  }

  if (context.searchResults.length > 0) {
    return [
      context.reason === "step_limit"
        ? "I reached my step limit before building a cart. These are the verified options I found:"
        : "I couldn't produce a verified final answer. These are the verified options I found:",
      ...context.searchResults
        .slice(0, 3)
        .map(
          (product) =>
            `- ${product.title} — ${formatInr(product.price)} (${product.sellerName})`,
        ),
      context.budgetPaise !== null
        ? `Your budget is ${formatInr(context.budgetPaise)}.`
        : "Tell me your budget and I'll narrow these down.",
    ].join("\n");
  }

  if (context.budgetPaise !== null) {
    return `I couldn't finish within the step limit. Your budget is ${formatInr(
      context.budgetPaise,
    )}. Tell me what you're looking for and I'll try again.`;
  }

  return "I couldn't finish this request. Tell me what you're shopping for and your budget, and I'll try again.";
}

function formatCartLines(cart: CartView): string[] {
  return cart.lines.map(
    (line) => `- ${line.title} × ${line.quantity} — ${formatInr(line.lineTotalPaise)}`,
  );
}

function unknownCostNames(budget: BudgetResult): string {
  const names = [
    budget.unknownCosts.shipping ? "shipping" : null,
    budget.unknownCosts.tax ? "tax" : null,
  ].filter((value): value is string => value !== null);
  return names.join(" and ");
}

function formatCostNote(budget: BudgetResult): string {
  if (!budget.hasUnknownCosts) return "";
  return `${unknownCostNames(budget)} is unknown, so the total shown is the known total, not a final promise.`;
}
