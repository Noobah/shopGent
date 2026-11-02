import { describe, expect, it } from "vitest";
import {
  collectKnownAmountsPaise,
  collectKnownNames,
  collectKnownUrls,
  extractMoneyMentions,
  verifyFinalAnswer,
} from "@/modules/agent/verify";

/**
 * The no-invented-numbers check. A final answer may only contain amounts,
 * product names and URLs that trace back to tool data (or the session budget).
 */

const MONITOR_TITLE = "LG UltraGear 27UL650 27-inch 4K UHD IPS Gaming Monitor";
const MONITOR_URL = "https://www.amazon.in/dp/B08XXXX001";

const TOOL_PAYLOADS: unknown[] = [
  {
    products: [
      {
        title: MONITOR_TITLE,
        brand: "LG",
        modelNumber: "27UL650-W",
        sellerName: "LG Official Store",
        price: 3_499_900,
        mrp: 4_499_900,
        url: MONITOR_URL,
      },
    ],
    count: 1,
  },
  {
    budget: {
      budgetPaise: 6_000_000,
      subtotalPaise: 3_499_900,
      totalPaise: 3_499_900,
      remainingPaise: 2_500_100,
      overagePaise: 0,
      lineCount: 1,
    },
  },
];

describe("collectKnownAmountsPaise", () => {
  it("collects price/mrp/paise fields recursively", () => {
    expect(collectKnownAmountsPaise(TOOL_PAYLOADS)).toEqual(
      expect.arrayContaining([3_499_900, 4_499_900, 6_000_000, 2_500_100]),
    );
  });
});

describe("extractMoneyMentions", () => {
  it("parses rupee, Rs and multiplier mentions", () => {
    expect(extractMoneyMentions("₹34,999 and Rs. 1,299.50 or 1.2 lakh")).toEqual(
      expect.arrayContaining([3_499_900, 129_950, 12_000_000]),
    );
  });
});

describe("collectKnownNames / URLs", () => {
  it("collects titles, brands, models, sellers and URLs", () => {
    const names = collectKnownNames(TOOL_PAYLOADS);
    expect(names.raw).toContain(MONITOR_TITLE);
    expect(collectKnownUrls(TOOL_PAYLOADS)).toContain(MONITOR_URL);
  });
});

describe("verifyFinalAnswer", () => {
  it("accepts verified amounts, known names and known URLs", () => {
    const result = verifyFinalAnswer({
      text: `The "${MONITOR_TITLE}" is ₹34,999.00 and fits your ₹60,000.00 budget. Link: ${MONITOR_URL}`,
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects an invented price", () => {
    const result = verifyFinalAnswer({
      text: `I found it for ₹29,999.00.`,
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("₹29,999.00");
  });

  it("rejects a quoted product name that no tool returned", () => {
    const result = verifyFinalAnswer({
      text: `I recommend "Sony WH-1000XM5" instead.`,
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/Quoted name|WH-1000XM5/);
  });

  it("rejects an invented URL", () => {
    const result = verifyFinalAnswer({
      text: "Buy here: https://evil.example.com/fake",
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("https://evil.example.com/fake");
  });

  it("rejects an empty answer", () => {
    const result = verifyFinalAnswer({
      text: "   ",
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.ok).toBe(false);
  });

  it("allows common spec tokens such as 4K", () => {
    const result = verifyFinalAnswer({
      text: "The 4K monitor is ₹34,999.00.",
      budgetPaise: 6_000_000,
      toolPayloads: TOOL_PAYLOADS,
    });
    expect(result.ok).toBe(true);
  });
});
