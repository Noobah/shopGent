import { runLLMContractSuite } from "./llm-contract";
import { MockProvider, type MockScript } from "@/modules/llm/mock";
import type { LLMEvent, LLMProvider } from "@/modules/llm/provider";

/**
 * Contract suite — MOCK adapter.
 *
 * The mock's harness is trivial: it maps a scripted list of normalized events
 * into the equivalent MockScript, so the mock is held to the exact same contract
 * as the real Grok adapter.
 */

function eventsToScript(events: LLMEvent[]): MockScript {
  let text = "";
  let finishReason: "stop" | "tool_calls" | undefined;
  let usage: MockScript["usage"];
  const toolCalls: { id: string; name: string; input: unknown }[] = [];

  for (const ev of events) {
    if (ev.type === "text_delta") {
      text += ev.delta;
    } else if (ev.type === "tool_call") {
      toolCalls.push({
        id: ev.toolCall.id,
        name: ev.toolCall.name,
        input: ev.toolCall.input,
      });
    } else if (ev.type === "usage") {
      usage = ev.usage;
    } else if (ev.type === "finish") {
      finishReason = ev.reason === "tool_calls" ? "tool_calls" : "stop";
    }
  }

  const steps: MockScript["steps"] = [];
  if (toolCalls.length > 0) {
    if (text) steps.push({ kind: "text", text });
    steps.push({
      kind: "tool_call",
      ...toolCalls[0]!,
      ...{ input: toolCalls[0]!.input },
    });
    // MockProvider's tool_call step takes a single call; additional calls go
    // through the text_and_tool_calls shape is overkill here — the contract
    // only ever requests one tool call per script, so keep it simple.
  } else if (text) {
    steps.push({ kind: "text", text });
  } else {
    steps.push({ kind: "text", text: "" });
  }

  return { steps, finishReason, usage };
}

runLLMContractSuite("MockProvider", {
  makeProvider(events: LLMEvent[]): LLMProvider {
    return new MockProvider({ script: eventsToScript(events) });
  },
});
