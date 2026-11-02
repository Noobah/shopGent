import { describe, expect, it } from "vitest";
import {
  decodeSseEvents,
  encodeSseEvent,
  agentEventSchema,
  type AgentEvent,
} from "@/modules/agent/events";

/**
 * SSE encoding is a contract: the client parses `event:` + `data:` frames, and
 * every payload must survive the same Zod schema the loop produced it with.
 */

describe("agent SSE events", () => {
  it("encodes a frame with the event name and JSON data", () => {
    const frame = encodeSseEvent({
      type: "status",
      status: "thinking",
      step: 1,
    });
    expect(frame.startsWith("event: status\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("round-trips all event types", () => {
    const events: AgentEvent[] = [
      { type: "status", status: "started", sessionId: "s1" },
      {
        type: "tool_start",
        step: 1,
        callId: "c1",
        tool: "search_products",
        input: { query: "monitor" },
      },
      {
        type: "tool_result",
        step: 1,
        callId: "c1",
        tool: "search_products",
        ok: true,
        result: { count: 1 },
        durationMs: 3,
      },
      {
        type: "cart_update",
        cart: {
          sessionId: "s1",
          itemCount: 0,
          subtotalPaise: 0,
          lines: [],
        },
      },
      { type: "message_delta", delta: "hello" },
      {
        type: "handoff_ready",
        handoffId: "h1",
        budget: {
          budgetPaise: 6_000_000,
          lineCount: 1,
          subtotalPaise: 3_499_900,
          shippingPaise: 0,
          shippingKnown: true,
          taxPaise: 0,
          taxKnown: true,
          totalPaise: 3_499_900,
          remainingPaise: 2_500_100,
          overagePaise: 0,
          fitsKnownBudget: true,
          withinBudget: true,
          hasUnknownCosts: false,
          unknownCosts: { shipping: false, tax: false },
        },
      },
      { type: "error", code: "LLM_ERROR", message: "failed", recoverable: true },
      { type: "done", sessionId: "s1", status: "completed", steps: 2 },
    ];

    const body = events.map(encodeSseEvent).join("");
    expect(decodeSseEvents(body)).toEqual(events);
  });

  it("rejects an invalid event before it reaches the wire", () => {
    expect(() =>
      encodeSseEvent({
        type: "done",
        sessionId: "s1",
        status: "nonsense",
        steps: 0,
      } as unknown as AgentEvent),
    ).toThrow();
    expect(agentEventSchema.safeParse({ type: "status" }).success).toBe(false);
  });
});
