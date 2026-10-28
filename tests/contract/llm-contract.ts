import { describe, it, expect } from "vitest";
import type {
  ChatOptions,
  LLMEvent,
  LLMProvider,
  ToolCall,
} from "@/modules/llm/provider";
import { collectStream } from "@/modules/llm/provider";

/**
 * Shared LLMProvider CONTRACT suite.
 *
 * The same assertions run against every adapter — the mock AND Grok (with its
 * HTTP layer faked). If an adapter violates the normalized event contract, this
 * suite fails. Adding a new provider = write an adapter + a `makeProvider`,
 * and it inherits the whole suite.
 */

export interface ContractHarness {
  /** Build a provider whose next `chat()` yields `events` (already normalized). */
  makeProvider(events: LLMEvent[]): LLMProvider;
}

export function runLLMContractSuite(label: string, harness: ContractHarness): void {
  describe(`LLMProvider contract — ${label}`, () => {
    it("yields a terminal finish event", async () => {
      const provider = harness.makeProvider([
        { type: "text_delta", delta: "hi" },
        { type: "finish", reason: "stop" },
      ]);
      const out = await collectStream(provider.chat({ messages: [] }));
      expect(out.finishReason).toBe("stop");
    });

    it("accumulates text deltas in order", async () => {
      const provider = harness.makeProvider([
        { type: "text_delta", delta: "Hello" },
        { type: "text_delta", delta: " " },
        { type: "text_delta", delta: "world" },
        { type: "finish", reason: "stop" },
      ]);
      const out = await collectStream(provider.chat({ messages: [] }));
      expect(out.text).toBe("Hello world");
    });

    it("emits tool calls with id, name, and a JSON-args string", async () => {
      const provider = harness.makeProvider([
        {
          type: "tool_call",
          toolCall: {
            id: "call_1",
            name: "search_products",
            input: '{"query":"monitor"}',
          },
        },
        { type: "finish", reason: "tool_calls" },
      ]);
      const out = await collectStream(provider.chat({ messages: [] }));
      expect(out.toolCalls).toHaveLength(1);
      const tc: ToolCall = out.toolCalls[0]!;
      expect(tc.id).toBe("call_1");
      expect(tc.name).toBe("search_products");
      // The agent validates this with Zod, so it must be parseable JSON.
      expect(() => JSON.parse(tc.input)).not.toThrow();
      expect(JSON.parse(tc.input)).toEqual({ query: "monitor" });
    });

    it("reports usage when provided", async () => {
      const provider = harness.makeProvider([
        {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        { type: "finish", reason: "stop" },
      ]);
      const out = await collectStream(provider.chat({ messages: [] }));
      expect(out.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it("ends the stream with a finish event as the LAST event", async () => {
      const provider = harness.makeProvider([
        { type: "text_delta", delta: "ok" },
        { type: "finish", reason: "stop" },
      ]);
      const events: LLMEvent[] = [];
      // Consume the raw stream (not collectStream) so we can inspect ordering.
      for await (const ev of provider.chat({ messages: [] })) {
        events.push(ev);
      }
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]).toEqual({ type: "finish", reason: "stop" });
      // No event of any kind may follow the finish event.
      const finishIndex = events.findIndex((e) => e.type === "finish");
      expect(finishIndex).toBe(events.length - 1);
    });

    it("accepts an empty message list without throwing", async () => {
      const provider = harness.makeProvider([{ type: "finish", reason: "stop" }]);
      await expect(collectStream(provider.chat({ messages: [] }))).resolves.toBeTruthy();
    });

    it("forwards an abort signal without hanging", async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = harness.makeProvider([
        { type: "text_delta", delta: "never" },
        { type: "finish", reason: "stop" },
      ]);
      const opts: ChatOptions = { messages: [], signal: controller.signal };
      // Must resolve (not hang) even though the signal is already aborted.
      const out = await collectStream(provider.chat(opts));
      expect(out.finishReason === "error" || out.finishReason === "stop").toBe(true);
    });
  });
}
