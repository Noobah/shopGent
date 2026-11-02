import type {
  ChatOptions,
  LLMEvent,
  LLMMessage,
  LLMProvider,
  ToolCall,
} from "./provider";

/**
 * MockProvider — deterministic, scripted responses.
 *
 * This is the DEFAULT provider for dev and every test (per the test-discipline
 * rules: no real API keys in tests). It replays a script of steps; each step is
 * either a text response, a tool call, or both. The agent loop can be driven
 * through any conversation shape without touching the network.
 *
 * Script selection:
 *  - If `sequence` is provided, the Nth chat() call gets the Nth script. This
 *    is what drives a multi-turn agent loop deterministically (tool call ->
 *    tool result -> next tool call -> final answer). After the sequence is
 *    exhausted the last script repeats, which lets tests exercise the step cap.
 *  - Otherwise, if a `scripts` map is provided, the script is chosen by the
 *    LAST user message (exact match), falling back to `defaultScript`.
 *  - If no scripts are given, a single `script` (or an empty reply) is used.
 */

export type ScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id?: string; name: string; input: unknown }
  | { kind: "text_and_tool_calls"; text: string; toolCalls: ScriptToolCall[] };

export interface ScriptToolCall {
  id?: string;
  name: string;
  input: unknown;
}

export interface MockScript {
  steps: ScriptStep[];
  /** Optional forced finish reason; defaults to inferred from the steps. */
  finishReason?: "stop" | "tool_calls";
  /** Optional usage to report; defaults to zeros. Lets tests script exact tokens. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface MockProviderOptions {
  /** A single script used for every request. */
  script?: MockScript;
  /** Map of last-user-message -> script, plus an optional `default`. */
  scripts?: Record<string, MockScript>;
  /**
   * Per-call scripts, consumed in order. After exhaustion the last script
   * repeats (useful for step-cap tests).
   */
  sequence?: MockScript[];
  /** Model label reported by the provider. */
  model?: string;
  /** Artificial delay per step (ms) to exercise streaming timing in tests. */
  delayMs?: number;
}

const EMPTY_SCRIPT: MockScript = { steps: [{ kind: "text", text: "" }] };

export class MockProvider implements LLMProvider {
  readonly id = "mock";
  readonly model: string;

  private readonly script?: MockScript;
  private readonly scripts?: Record<string, MockScript>;
  private readonly sequence?: MockScript[];
  private readonly delayMs: number;
  private sequenceIndex = 0;

  /** Every request received, so tests can assert on messages/tools sent. */
  readonly calls: ChatOptions[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? "mock-model";
    this.script = options.script;
    this.scripts = options.scripts;
    this.sequence = options.sequence;
    this.delayMs = options.delayMs ?? 0;
  }

  /** Reset the per-call sequence (tests reuse one provider instance). */
  resetSequence(): void {
    this.sequenceIndex = 0;
  }

  private pickScript(messages: LLMMessage[]): MockScript {
    if (this.sequence && this.sequence.length > 0) {
      const index = Math.min(this.sequenceIndex, this.sequence.length - 1);
      this.sequenceIndex += 1;
      // Non-empty by construction; the fallback keeps TS happy.
      return this.sequence[index] ?? EMPTY_SCRIPT;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const key = lastUser?.content ?? "";

    if (this.scripts) {
      const matched = this.scripts[key] ?? this.scripts["default"];
      if (matched) return matched;
    }
    if (this.script) return this.script;
    return EMPTY_SCRIPT;
  }

  async *chat(options: ChatOptions): AsyncIterable<LLMEvent> {
    this.calls.push(options);

    // Honor abort before producing anything.
    if (options.signal?.aborted) {
      yield { type: "finish", reason: "error" };
      return;
    }

    const script = this.pickScript(options.messages);
    let sawToolCall = false;

    for (const step of script.steps) {
      if (options.signal?.aborted) {
        yield { type: "finish", reason: "error" };
        return;
      }
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }

      if (step.kind === "text") {
        // Stream the text in small chunks so consumers see multiple deltas.
        for (const chunk of chunkText(step.text)) {
          yield { type: "text_delta", delta: chunk };
        }
      } else if (step.kind === "tool_call") {
        sawToolCall = true;
        yield { type: "tool_call", toolCall: toToolCall(step) };
      } else {
        for (const chunk of chunkText(step.text)) {
          yield { type: "text_delta", delta: chunk };
        }
        sawToolCall = true;
        for (const tc of step.toolCalls) {
          yield { type: "tool_call", toolCall: toToolCall(tc) };
        }
      }
    }

    yield {
      type: "usage",
      usage: script.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    yield {
      type: "finish",
      reason: script.finishReason ?? (sawToolCall ? "tool_calls" : "stop"),
    };
  }
}

function toToolCall(step: ScriptToolCall): ToolCall {
  return {
    id: step.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: step.name,
    // The agent validates this JSON with Zod, so serialize deterministically.
    input: typeof step.input === "string" ? step.input : JSON.stringify(step.input),
  };
}

/** Split text into small chunks to simulate token-by-token streaming. */
function chunkText(text: string, size = 12): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
