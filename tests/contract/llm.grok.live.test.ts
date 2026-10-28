import { describe, it, expect } from "vitest";
import { createLLMProvider } from "@/modules/llm";
import { GrokProvider } from "@/modules/llm/grok";
import { collectStream } from "@/modules/llm/provider";

/**
 * LIVE Grok tests — real calls to the xAI API.
 *
 * Per the test-discipline rules these are OFF by default: the whole suite runs
 * keyless against the mock and the HTTP-faked adapter. Enable explicitly with:
 *
 *   RUN_LIVE_TESTS=1 GROK_API_KEY=... pnpm test
 *
 * They exercise the same seam as the contract suite, just against the real wire.
 */
const liveEnabled = process.env.RUN_LIVE_TESTS === "1";
const apiKey = process.env.GROK_API_KEY;
const hasKey = Boolean(apiKey);

describe.runIf(liveEnabled && hasKey)("Grok LIVE (RUN_LIVE_TESTS=1)", () => {
  it("streams a plain completion with a terminal finish event", async () => {
    const provider = createLLMProvider({ provider: "grok" }) as GrokProvider;
    const out = await collectStream(
      provider.chat({
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        maxTokens: 32,
        temperature: 0,
      }),
    );
    expect(out.text.toLowerCase()).toContain("pong");
    expect(out.finishReason).toBe("stop");
    if (out.usage) expect(out.usage.totalTokens).toBeGreaterThan(0);
  });

  it("reports the configured model id", () => {
    const provider = createLLMProvider({ provider: "grok" });
    expect(provider.id).toBe("grok");
    expect(provider.model.length).toBeGreaterThan(0);
  });
});

describe.runIf(liveEnabled && !hasKey)("Grok LIVE misconfiguration", () => {
  it("fails loudly when RUN_LIVE_TESTS=1 but no key is set", () => {
    expect(() => createLLMProvider({ provider: "grok" })).toThrow(/GROK_API_KEY/);
  });
});

describe.runIf(!liveEnabled)("Grok LIVE (disabled by default)", () => {
  it("does not hit the network unless RUN_LIVE_TESTS=1", () => {
    expect(process.env.RUN_LIVE_TESTS).not.toBe("1");
  });
});
