import { describe, expect, it } from "vitest";
import { parseBudgetPaise } from "@/modules/budget";

/**
 * Budget parsing is the ONLY place the user's budget enters the system. The
 * tests below pin the deterministic cases the agent depends on, including the
 * "message quotes a product price AND a budget" trap.
 */

describe("parseBudgetPaise", () => {
  it("reads an explicit rupee amount with Indian grouping", () => {
    expect(parseBudgetPaise("gaming setup under ₹60,000: monitor, keyboard, mouse")).toBe(
      6_000_000,
    );
    expect(parseBudgetPaise("₹1,00,000 for a laptop")).toBe(10_000_000);
  });

  it("supports Rs/INR and paise decimals", () => {
    expect(parseBudgetPaise("Rs. 1,299.50 max")).toBe(129_950);
    expect(parseBudgetPaise("INR 45,000")).toBe(4_500_000);
  });

  it("supports k/lakh/crore multipliers", () => {
    expect(parseBudgetPaise("budget is 60k")).toBe(6_000_000);
    expect(parseBudgetPaise("within ₹1.2 lakh")).toBe(12_000_000);
    expect(parseBudgetPaise("up to 1 crore")).toBe(1_000_000_000);
  });

  it("prefers a budget cue over an unrelated product price", () => {
    expect(parseBudgetPaise("the monitor costs ₹34,999, but my budget is ₹30,000")).toBe(
      3_000_000,
    );
    expect(parseBudgetPaise("I like the ₹34,999 monitor — under ₹25,000 please")).toBe(
      2_500_000,
    );
  });

  it("does not mistake a small quantity for a bare budget", () => {
    expect(parseBudgetPaise("under 2 monitors for 60000")).toBeNull();
  });

  it("does not mistake a display spec for a budget", () => {
    expect(parseBudgetPaise("I need a 4K monitor")).toBeNull();
    expect(parseBudgetPaise("a 4K monitor under ₹60,000")).toBe(6_000_000);
  });

  it("accepts a standalone suffix when the context is clearly money", () => {
    expect(parseBudgetPaise("I have 60k to spend")).toBe(6_000_000);
  });

  it("returns null for missing, zero, or absurd budgets", () => {
    expect(parseBudgetPaise("I want a gaming setup")).toBeNull();
    expect(parseBudgetPaise("")).toBeNull();
    expect(parseBudgetPaise("₹0")).toBeNull();
    expect(parseBudgetPaise("₹999999999999999999")).toBeNull();
  });
});
