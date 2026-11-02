import { ExternalServiceError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type {
  ChatOptions,
  LLMEvent,
  LLMMessage,
  LLMProvider,
  ToolCall,
  FinishReason,
} from "./provider";

/**
 * Grok adapter — xAI's OpenAI-compatible chat completions API.
 *
 * Translates the vendor SSE stream into the normalized LLMEvent shape. Tool
 * calls arrive as fragmented argument deltas across chunks, so we accumulate
 * them by index and emit a single `tool_call` event once complete (at finish).
 *
 * Hardening (per the prompt): every external call carries the abort signal, a
 * timeout, and error handling that maps to ExternalServiceError (502/504).
 */

export interface GrokProviderOptions {
  apiKey: string;
  model: string;
  /** Base URL without a trailing slash, e.g. https://api.x.ai */
  baseUrl: string;
  /**
   * Provider id reported by `LLMProvider.id`. Defaults to "grok"; the Groq
   * adapter reuses this exact wire protocol with id "groq" (both vendors speak
   * OpenAI-compatible chat completions).
   */
  id?: string;
  /** Human-readable vendor name used in errors and logs. Defaults to "Grok". */
  label?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch for tests (HTTP-level mocking). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

export class GrokProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly label: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GrokProviderOptions) {
    this.id = options.id ?? "grok";
    this.label = options.label ?? "Grok";
    if (!options.apiKey) {
      throw new ExternalServiceError(
        502,
        `${this.label}Provider requires an API key (set ${this.id === "groq" ? "SHOPSY_API_KEY" : "GROK_API_KEY"})`,
      );
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *chat(options: ChatOptions): AsyncIterable<LLMEvent> {
    // An already-aborted signal never fires its listener (registered below), so
    // check up front — otherwise we'd fire a request the caller cancelled.
    if (options.signal?.aborted) {
      yield { type: "finish", reason: "error" };
      return;
    }

    const controller = new AbortController();
    // Link the caller's signal to our timeout controller.
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toWireMessages(options.messages),
          tools: options.tools?.length ? toWireTools(options.tools) : undefined,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: true,
          // Ask the API to report token usage in the final chunk.
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await safeText(response);
        logger.error(`llm.${this.id}.http_error`, { status: response.status });
        const isTimeout = false;
        throw new ExternalServiceError(
          response.status === 504 || isTimeout ? 504 : 502,
          `${this.label} request failed (${response.status})`,
          { cause: detail },
        );
      }
      if (!response.body) {
        throw new ExternalServiceError(502, `${this.label} response had no body`);
      }

      yield* this.parseStream(response.body, controller.signal);
    } catch (err) {
      if (isAbort(err)) {
        // Distinguish a caller-initiated abort from our own timeout.
        if (options.signal?.aborted) {
          yield { type: "finish", reason: "error" };
          return;
        }
        logger.warn(`llm.${this.id}.timeout`, { timeoutMs: this.timeoutMs });
        throw new ExternalServiceError(504, `${this.label} request timed out`);
      }
      if (err instanceof ExternalServiceError) throw err;
      logger.error(`llm.${this.id}.unknown_error`, { err });
      throw new ExternalServiceError(502, `${this.label} request failed`, { cause: err });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Parse the OpenAI-style SSE stream into normalized events. */
  private async *parseStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const pending = new Map<number, PendingToolCall>();
    let buffer = "";
    let sawToolCall = false;
    let finishReason: FinishReason | null = null;

    try {
      for (;;) {
        if (signal.aborted) {
          yield { type: "finish", reason: "error" };
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        // Keep the trailing partial frame in the buffer.
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          for (const rawLine of frame.split("\n")) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let chunk: OpenAIChunk;
            try {
              chunk = JSON.parse(payload) as OpenAIChunk;
            } catch {
              // Tolerate malformed frames rather than killing the stream.
              continue;
            }

            // Token usage usually arrives on a separate final chunk.
            if (chunk.usage) {
              yield {
                type: "usage",
                usage: {
                  promptTokens: chunk.usage.prompt_tokens ?? 0,
                  completionTokens: chunk.usage.completion_tokens ?? 0,
                  totalTokens: chunk.usage.total_tokens ?? 0,
                },
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // 1) Text content.
            if (delta?.content) {
              yield { type: "text_delta", delta: delta.content };
            }

            // 2) Tool-call fragments — accumulate by index.
            if (delta?.tool_calls) {
              sawToolCall = true;
              for (const frag of delta.tool_calls) {
                const index = frag.index ?? 0;
                let entry = pending.get(index);
                if (!entry) {
                  entry = { id: frag.id ?? `call_${index}`, name: "", args: "" };
                  pending.set(index, entry);
                }
                if (frag.id) entry.id = frag.id;
                if (frag.function?.name) entry.name += frag.function.name;
                if (frag.function?.arguments) entry.args += frag.function.arguments;
              }
            }

            // 3) Finish reason.
            if (choice.finish_reason) {
              finishReason = mapFinishReason(choice.finish_reason);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit completed tool calls now that the stream is done.
    for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const toolCall: ToolCall = { id: entry.id, name: entry.name, input: entry.args };
      yield { type: "tool_call", toolCall };
    }

    yield {
      type: "finish",
      reason: finishReason ?? (sawToolCall ? "tool_calls" : "stop"),
    };
  }
}

// ---- wire-format helpers -------------------------------------------------

/** Map normalized messages to the OpenAI/Grok message shape. */
function toWireMessages(messages: LLMMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content ?? "" };
    }
    if (m.toolCalls?.length) {
      return {
        role: m.role,
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.input },
        })),
      };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}

/** Map normalized tool definitions to OpenAI function-tool shape. */
function toWireTools(tools: ChatOptions["tools"]): unknown[] {
  return (tools ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "AbortError")
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
