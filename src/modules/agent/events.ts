import { z } from "zod";
import { budgetResultSchema } from "@/modules/budget";
import { cartViewSchema } from "./cart";

/**
 * SSE event contract for POST /api/agent/stream.
 *
 * One Zod discriminated union is the single source of truth: the loop produces
 * these objects, the route validates + serializes them, and tests decode the
 * same shapes. No ad-hoc payloads or `as` casts at the boundary.
 */

export const agentStatusSchema = z.enum([
  "started",
  "thinking",
  "tool_running",
  "verifying",
  "regenerating",
  "handoff_ready",
  "completed",
  "limit_reached",
  "aborted",
  "error",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    status: agentStatusSchema,
    message: z.string().optional(),
    step: z.number().int().min(0).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("tool_start"),
    step: z.number().int().min(1),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    step: z.number().int().min(1),
    callId: z.string().min(1),
    tool: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: agentErrorSchema.optional(),
    durationMs: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("cart_update"),
    cart: cartViewSchema,
  }),
  z.object({
    type: z.literal("message_delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("handoff_ready"),
    handoffId: z.string().min(1),
    budget: budgetResultSchema,
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("done"),
    sessionId: z.string().min(1),
    status: z.enum(["completed", "handoff_ready", "limit_reached", "aborted", "error"]),
    steps: z.number().int().min(0),
    handoffId: z.string().min(1).optional(),
    cart: cartViewSchema.optional(),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentDoneStatus = Extract<AgentEvent, { type: "done" }>["status"];

/** Validate and serialize one event as an SSE frame. */
export function encodeSseEvent(event: AgentEvent): string {
  const parsed = agentEventSchema.parse(event);
  return `event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`;
}

/** Parse a complete SSE response body into events (tests/debugging). */
export function decodeSseEvents(body: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const raw = dataLine.slice(5).trim();
    if (!raw) continue;
    events.push(agentEventSchema.parse(JSON.parse(raw)));
  }
  return events;
}
