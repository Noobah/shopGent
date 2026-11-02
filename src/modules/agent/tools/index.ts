import { logger } from "@/lib/logger";
import {
  addToCartTool,
  buildHandoffTool,
  checkBudgetTool,
  removeFromCartTool,
} from "./cart";
import {
  compareProductsTool,
  getProductDetailsTool,
  searchProductsTool,
} from "./products";
import {
  ToolError,
  toToolDefinition,
  type AgentTool,
  type ToolContext,
  type ToolExecution,
} from "./types";

/**
 * Tool registry.
 *
 * The registry is the single allowlist for what the model can do. Unknown names
 * are rejected before any code runs. Inputs are parsed as JSON and then
 * Zod-validated inside each tool; outputs are validated here before they enter
 * the conversation.
 */

export * from "./cart";
export * from "./products";
export * from "./types";

export const AGENT_TOOLS: readonly AgentTool[] = [
  searchProductsTool,
  getProductDetailsTool,
  compareProductsTool,
  addToCartTool,
  removeFromCartTool,
  checkBudgetTool,
  buildHandoffTool,
];

const BY_NAME = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** OpenAI function-tool definitions for the LLM request. */
export const AGENT_TOOL_DEFINITIONS = AGENT_TOOLS.map(toToolDefinition);

export function getToolByName(name: string): AgentTool | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * Parse the raw arguments string as JSON without enforcing the tool schema.
 * Invalid JSON is returned as a string so tool_start/traces can show exactly
 * what the model sent; the tool execution will reject it with INVALID_INPUT.
 */
export function parseToolInput(rawInput: string): unknown {
  const trimmed = rawInput.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return rawInput;
  }
}

export interface ToolInvocationResult extends ToolExecution {
  toolName: string;
  /** Parsed JSON (possibly still schema-invalid) for events/traces. */
  input: unknown;
  /** Schema-validated output. */
  output: unknown;
}

export async function invokeTool(
  toolName: string,
  context: ToolContext,
  rawInput: string,
): Promise<ToolInvocationResult> {
  const tool = BY_NAME.get(toolName);
  if (!tool) {
    throw new ToolError(
      "UNKNOWN_TOOL",
      `Unknown tool "${toolName}". Use only the tools provided in this request.`,
    );
  }

  const input = parseToolInput(rawInput);
  const execution = await tool.execute(context, input);

  let output: unknown;
  try {
    output = tool.outputSchema.parse(execution.output);
  } catch (err) {
    logger.error("agent.tool_output_invalid", { tool: toolName, err });
    throw new ToolError(
      "TOOL_OUTPUT_INVALID",
      `${toolName} returned malformed data. Continue without its result and do not guess.`,
    );
  }

  return {
    ...execution,
    toolName,
    input,
    output,
  };
}
