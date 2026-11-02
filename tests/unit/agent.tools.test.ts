import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOL_DEFINITIONS,
  getToolByName,
  parseToolInput,
} from "@/modules/agent/tools";
import {
  addToCartTool,
  checkBudgetTool,
  compareProductsTool,
  searchProductsTool,
} from "@/modules/agent/tools";

/**
 * Tool schemas are the boundary between an untrusted model and our code.
 * These tests pin the important validation rules without touching the DB.
 */

describe("tool registry", () => {
  it("exposes exactly the seven allowed tools", () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "search_products",
      "get_product_details",
      "compare_products",
      "add_to_cart",
      "remove_from_cart",
      "check_budget",
      "build_handoff",
    ]);
  });

  it("generates function definitions without $schema", () => {
    expect(AGENT_TOOL_DEFINITIONS).toHaveLength(7);
    for (const definition of AGENT_TOOL_DEFINITIONS) {
      expect(definition.name).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(definition.parameters).not.toHaveProperty("$schema");
    }
  });

  it("rejects unknown tool names", () => {
    expect(getToolByName("delete_everything")).toBeNull();
    expect(getToolByName("search_products")?.name).toBe("search_products");
  });

  it("parses JSON args and preserves invalid JSON for the error path", () => {
    expect(parseToolInput('{"query":"monitor"}')).toEqual({ query: "monitor" });
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput("{not json")).toBe("{not json");
  });
});

describe("tool input validation", () => {
  it("search_products has no model-controlled limit", () => {
    const parsed = searchProductsTool.inputSchema.safeParse({ query: "mouse" });
    expect(parsed.success).toBe(true);
    const withLimit = searchProductsTool.inputSchema.safeParse({
      query: "mouse",
      limit: 500,
    });
    expect(withLimit.success).toBe(true); // unknown keys are stripped
    if (withLimit.success) {
      expect(withLimit.data).not.toHaveProperty("limit");
    }
  });

  it("add_to_cart requires a positive quantity", () => {
    expect(
      addToCartTool.inputSchema.safeParse({ productId: "p1", quantity: 0 }).success,
    ).toBe(false);
    expect(
      addToCartTool.inputSchema.safeParse({ productId: "p1", quantity: 100 }).success,
    ).toBe(false);
    expect(
      addToCartTool.inputSchema.safeParse({ productId: "p1", quantity: 2 }).success,
    ).toBe(true);
  });

  it("compare_products requires 2-10 ids", () => {
    expect(compareProductsTool.inputSchema.safeParse({ productIds: ["a"] }).success).toBe(
      false,
    );
    expect(
      compareProductsTool.inputSchema.safeParse({ productIds: ["a", "b"] }).success,
    ).toBe(true);
  });

  it("check_budget bounds the tax rate and rejects negative shipping", () => {
    expect(checkBudgetTool.inputSchema.safeParse({ taxRatePercent: 18 }).success).toBe(
      true,
    );
    expect(checkBudgetTool.inputSchema.safeParse({ taxRatePercent: 101 }).success).toBe(
      false,
    );
    expect(checkBudgetTool.inputSchema.safeParse({ flatShippingPaise: -1 }).success).toBe(
      false,
    );
  });
});
