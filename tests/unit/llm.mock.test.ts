import { describe, it, expect } from "vitest";
import { MockProvider, type MockScript } from "@/modules/llm/mock";
import { collectStream } from "@/modules/llm/provider";

/**
 * MockProvider unit tests — behaviors specific to the scripted adapter that the
 * shared contract suite doesn't cover (script selection, multi-call steps,
 * abort, and delta chunking).
 */

describe("MockProvider script selection", () => {
  const scripts: Record<string, MockScript> = {
    default: { steps: [{ kind: "text", text: "default reply" }] },
    "find a monitor": { steps: [{ kind: "text", text: "monitor reply" }] },
    "under budget": {
      steps: [{ kind: "tool_call", name: "check_budget", input: { budget: 50000 } }],
      finishReason: "tool_calls",
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    },
  };

  it("picks the script matching the LAST user message", async () => {
    const p = new MockProvider({ scripts });
    const out = await collectStream(
      p.chat({
        messages: [
          { role: "user", content: "find a monitor" },
          { role: "assistant", content: "sure" },
          { role: "user", content: "under budget" },
        ],
      }),
    );
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.name).toBe("check_budget");
    expect(out.finishReason).toBe("tool_calls");
    expect(out.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it("falls back to the `default` script when nothing matches", async () => {
    const p = new MockProvider({ scripts });
    const out = await collectStream(
      p.chat({ messages: [{ role: "user", content: "???" }] }),
    );
    expect(out.text).toBe("default reply");
    expect(out.finishReason).toBe("stop");
  });

  it("uses a single `script` for every request when scripts map is absent", async () => {
    const p = new MockProvider({ script: { steps: [{ kind: "text", text: "always" }] } });
    const a = await collectStream(
      p.chat({ messages: [{ role: "user", content: "one" }] }),
    );
    const b = await collectStream(
      p.chat({ messages: [{ role: "user", content: "two" }] }),
    );
    expect(a.text).toBe("always");
    expect(b.text).toBe("always");
  });

  it("returns an empty reply when no script is configured at all", async () => {
    const p = new MockProvider();
    const out = await collectStream(p.chat({ messages: [] }));
    expect(out.text).toBe("");
    expect(out.finishReason).toBe("stop");
  });
});

describe("MockProvider multi-step + tool calls", () => {
  it("emits text and multiple tool calls in a single turn", async () => {
    const p = new MockProvider({
      script: {
        steps: [
          {
            kind: "text_and_tool_calls",
            text: "Let me look.",
            toolCalls: [
              { id: "a", name: "search_products", input: { query: "monitor" } },
              { id: "b", name: "search_products", input: { query: "keyboard" } },
            ],
          },
        ],
      },
    });
    const out = await collectStream(p.chat({ messages: [] }));
    expect(out.text).toBe("Let me look.");
    expect(out.toolCalls.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out.finishReason).toBe("tool_calls");
    expect(JSON.parse(out.toolCalls[1]!.input)).toEqual({ query: "keyboard" });
  });

  it("records every request so tests can assert on messages/tools sent", async () => {
    const p = new MockProvider();
    await collectStream(
      p.chat({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
      }),
    );
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.tools?.[0]!.name).toBe("t");
  });
});

describe("MockProvider abort + streaming", () => {
  it("yields a terminal finish with reason `error` when already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const p = new MockProvider({ script: { steps: [{ kind: "text", text: "never" }] } });
    const out = await collectStream(p.chat({ messages: [], signal: c.signal }));
    expect(out.finishReason).toBe("error");
    expect(out.text).toBe("");
  });

  it("streams text as multiple deltas (not one blob)", async () => {
    const p = new MockProvider({
      script: { steps: [{ kind: "text", text: "a".repeat(60) }] },
    });
    const deltas: string[] = [];
    for await (const ev of p.chat({ messages: [] })) {
      if (ev.type === "text_delta") deltas.push(ev.delta);
    }
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("a".repeat(60));
  });

  it("reports its id and model for logging", () => {
    const p = new MockProvider({ model: "mock-abc" });
    expect(p.id).toBe("mock");
    expect(p.model).toBe("mock-abc");
  });
});
