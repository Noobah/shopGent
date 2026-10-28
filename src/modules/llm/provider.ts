import { z } from "zod";

/**
 * LLMProvider seam.
 *
 * This is one of the two allowed abstraction seams (the other is ProductSource).
 * Agent code talks ONLY to this interface; swapping Grok for another provider
 * means writing one adapter or changing an env var — zero changes to the agent.
 *
 * The interface returns a normalized async-iterable stream of events. Adapters
 * are responsible for translating their vendor wire format into this shape and
 * for parsing tool calls out of the vendor's streaming chunks.
 */

// ---- Message + tool-call shapes (normalized, provider-agnostic) ----------

export const roleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof roleSchema>;

/** A tool call requested by the model. `input` is the raw JSON args string. */
export interface ToolCall {
  /** Stable per-turn id (vendor id or synthesized). */
  id: string;
  /** The tool/function name the model wants to invoke. */
  name: string;
  /** Raw JSON arguments string. The agent validates with Zod before executing. */
  input: string;
}

export interface LLMMessage {
  role: Role;
  /** Text content. Null when the message is only tool calls. */
  content: string | null;
  /** Present on assistant messages that request one or more tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `tool` messages: the id of the tool call this responds to. */
  toolCallId?: string;
}

/** A tool the model may call, in OpenAI function-tool shape. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

// ---- Normalized streaming events -----------------------------------------

export type LLMEventType =
  | "text_delta" // incremental assistant text
  | "tool_call" // a fully-formed tool call
  | "usage" // token usage (usually once, near the end)
  | "finish"; // terminal event with finish reason

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCall: ToolCall;
}

export interface UsageEvent {
  type: "usage";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface FinishEvent {
  type: "finish";
  reason: FinishReason;
}

export type LLMEvent = TextDeltaEvent | ToolCallEvent | UsageEvent | FinishEvent;

// ---- chat() options + normalized finish info ----------------------------

export interface ChatOptions {
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  /** Abort signal — every external call must honor it. */
  signal?: AbortSignal;
  /** Sampling temperature. Adapters may ignore if unsupported. */
  temperature?: number;
  /** Max tokens for the completion. */
  maxTokens?: number;
}

/**
 * The provider interface. `chat` returns an async-iterable stream of
 * normalized LLMEvent objects. Adapters must:
 *  - forward `signal` to the underlying request and stop cleanly on abort
 *  - parse tool calls out of the vendor stream into `tool_call` events
 *  - always terminate the stream with a `finish` event
 */
export interface LLMProvider {
  /** Human-readable provider id, e.g. "grok" or "mock". */
  readonly id: string;
  /** The model in use, for logging/telemetry. */
  readonly model: string;
  chat(options: ChatOptions): AsyncIterable<LLMEvent>;
}

/** Consume a stream into its parts — handy for tests and non-streaming callers. */
export async function collectStream(stream: AsyncIterable<LLMEvent>): Promise<{
  text: string;
  toolCalls: ToolCall[];
  usage: UsageEvent["usage"] | null;
  finishReason: FinishReason | null;
}> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: UsageEvent["usage"] | null = null;
  let finishReason: FinishReason | null = null;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.delta;
        break;
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "finish":
        finishReason = event.reason;
        break;
    }
  }

  return { text, toolCalls, usage, finishReason };
}
