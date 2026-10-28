import { describe, it, expect } from "vitest";
import { runLLMContractSuite } from "./llm-contract";
import { GrokProvider } from "@/modules/llm/grok";
import { collectStream, type LLMEvent, type LLMProvider } from "@/modules/llm/provider";

/**
 * Contract suite — GROK adapter, with its HTTP layer faked.
 *
 * This is the important half: we encode the scripted events as a real
 * OpenAI-format SSE byte stream and let GrokProvider's parser decode it back.
 * So the adapter's chunk accumulation, tool-call fragment assembly, usage
 * extraction, and finish-reason mapping are all exercised — no network, no key.
 */

/** Encode normalized events into an OpenAI-style SSE stream. */
function encodeSSE(events: LLMEvent[]): string {
  let out = "";
  let toolIndex = 0;

  for (const ev of events) {
    if (ev.type === "text_delta") {
      out += `data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta } }] })}\n\n`;
    } else if (ev.type === "tool_call") {
      // Emit the tool call as a fragmented pair of chunks (name, then args) to
      // prove the adapter reassembles fragments across chunks.
      const idx = toolIndex++;
      out += `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: idx, id: ev.toolCall.id, function: { name: ev.toolCall.name } },
              ],
            },
          },
        ],
      })}\n\n`;
      out += `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: idx, function: { arguments: ev.toolCall.input } }],
            },
          },
        ],
      })}\n\n`;
    } else if (ev.type === "usage") {
      out += `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: ev.usage.promptTokens,
          completion_tokens: ev.usage.completionTokens,
          total_tokens: ev.usage.totalTokens,
        },
      })}\n\n`;
    } else if (ev.type === "finish") {
      out += `data: ${JSON.stringify({ choices: [{ finish_reason: ev.reason }] })}\n\n`;
    }
  }

  out += "data: [DONE]\n\n";
  return out;
}

/** Build a GrokProvider whose fetch returns the encoded SSE stream. */
function makeGrok(events: LLMEvent[]): GrokProvider {
  const body = encodeSSE(events);
  const fakeFetch: typeof fetch = async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  return new GrokProvider({
    apiKey: "test-key",
    model: "grok-test",
    baseUrl: "https://api.x.ai",
    fetchImpl: fakeFetch,
  });
}

runLLMContractSuite("GrokProvider (HTTP-faked)", {
  makeProvider: (events) => makeGrok(events) as unknown as LLMProvider,
});

describe("GrokProvider parsing (beyond the shared contract)", () => {
  it("reassembles a tool call fragmented across multiple chunks", async () => {
    // args deliberately split into two chunks.
    const events: LLMEvent[] = [
      {
        type: "tool_call",
        toolCall: { id: "call_9", name: "check_budget", input: '{"budget":60000}' },
      },
      { type: "finish", reason: "tool_calls" },
    ];
    const out = await collectStream(makeGrok(events).chat({ messages: [] }));
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.name).toBe("check_budget");
    expect(JSON.parse(out.toolCalls[0]!.input)).toEqual({ budget: 60000 });
    expect(out.finishReason).toBe("tool_calls");
  });

  it("maps finish reasons to the normalized vocabulary", async () => {
    const cases: Array<[string, string]> = [
      ["stop", "stop"],
      ["tool_calls", "tool_calls"],
      ["length", "length"],
      ["content_filter", "content_filter"],
    ];
    for (const [wire, expected] of cases) {
      const body = `data: ${JSON.stringify({ choices: [{ finish_reason: wire }] })}\n\ndata: [DONE]\n\n`;
      const provider = new GrokProvider({
        apiKey: "k",
        model: "m",
        baseUrl: "https://api.x.ai",
        fetchImpl: async () => new Response(body, { status: 200 }),
      });
      const out = await collectStream(provider.chat({ messages: [] }));
      expect(out.finishReason).toBe(expected);
    }
  });

  it("maps a non-2xx response to ExternalServiceError", async () => {
    const provider = new GrokProvider({
      apiKey: "k",
      model: "m",
      baseUrl: "https://api.x.ai",
      fetchImpl: async () => new Response("bad key", { status: 401 }),
    });
    await expect(collectStream(provider.chat({ messages: [] }))).rejects.toThrow(
      /Grok request failed \(401\)/,
    );
  });

  it("honors an already-aborted signal without hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = makeGrok([{ type: "finish", reason: "stop" }]);
    const out = await collectStream(
      provider.chat({ messages: [], signal: controller.signal }),
    );
    expect(out.finishReason).toBe("error");
  });

  it("tolerates a malformed SSE frame without killing the stream", async () => {
    const body =
      "data: {not-json}\n\n" +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const provider = new GrokProvider({
      apiKey: "k",
      model: "m",
      baseUrl: "https://api.x.ai",
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    const out = await collectStream(provider.chat({ messages: [] }));
    expect(out.text).toBe("ok");
    expect(out.finishReason).toBe("stop");
  });

  it("sends an Authorization bearer header and the configured model", async () => {
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const provider = new GrokProvider({
      apiKey: "sk-test-123",
      model: "grok-3",
      baseUrl: "https://api.x.ai",
      fetchImpl: async (_url, init) => {
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n", { status: 200 });
      },
    });
    await collectStream(provider.chat({ messages: [] }));
    expect(seenAuth).toBe("Bearer sk-test-123");
    expect(seenBody.model).toBe("grok-3");
  });
});
