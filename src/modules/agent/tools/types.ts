import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { BudgetResult } from "@/modules/budget";
import type { ProductSource, TrustPolicy } from "@/modules/products";
import type { CartItem, ChatSessionDoc } from "@/modules/sessions";

/**
 * Tool contract shared by the registry and the loop.
 *
 * Tools are the ONLY place the agent touches products/cart state. Each tool
 * declares a Zod input schema (also exported to the model as JSON Schema) and a
 * Zod output schema. The registry validates both sides, so a malformed tool call
 * or a buggy tool can never poison the conversation silently.
 */

/** Expected, safe tool failure returned to the model as `{ok:false,...}`. */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export interface ToolContext {
  userId: string;
  sessionId: string;
  /** Current session snapshot. Tools may update the in-memory copy. */
  session: ChatSessionDoc;
  /** Current cart lines. Tools replace this array after a mutation. */
  cartItems: CartItem[];
  productSource: ProductSource;
  trustPolicy: TrustPolicy;
  signal?: AbortSignal;
  now: () => Date;
}

export interface ToolExecution {
  /** JSON-serializable data returned to the model (and stored in traces). */
  output: unknown;
  /** Present when a cart-mutating tool produced a new cart. */
  cartItems?: CartItem[];
  /** Present when build_handoff succeeded. */
  handoff?: { id: string; budget: BudgetResult };
  /** Present when check_budget computed a result. */
  budget?: BudgetResult;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  execute(context: ToolContext, input: unknown): Promise<ToolExecution>;
}

/**
 * Helper that keeps a tool's `run` function strongly typed while the registry
 * stores it behind the uniform `AgentTool` interface.
 */
export function defineTool<Schema extends z.ZodTypeAny>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  outputSchema: z.ZodTypeAny;
  run: (context: ToolContext, input: z.infer<Schema>) => Promise<ToolExecution>;
}): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    execute: async (context, input) =>
      definition.run(context, definition.inputSchema.parse(input) as z.infer<Schema>),
  };
}

/** The error envelope returned to the model. Never includes stack traces. */
export interface ToolErrorPayload {
  code: string;
  message: string;
}

export function toToolErrorPayload(err: unknown): ToolErrorPayload {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message };
  }

  if (err instanceof z.ZodError) {
    return { code: "INVALID_INPUT", message: formatZodIssues(err) };
  }

  if (err instanceof AppError) {
    return { code: err.code, message: err.expose ? err.message : "Tool failed" };
  }

  if (isAbortError(err)) {
    return { code: "ABORTED", message: "The tool call was cancelled." };
  }

  return {
    code: "INTERNAL_TOOL_ERROR",
    message: "The tool failed unexpectedly. Continue without its result.",
  };
}

export function formatZodIssues(err: z.ZodError): string {
  const parts = err.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
  return parts.length > 0 ? parts.join("; ") : "Invalid tool input";
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError")
  );
}

/** Build the OpenAI function-tool definition from a tool's Zod schema. */
export function toToolDefinition(tool: AgentTool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  const jsonSchema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  // `$schema` is noise for function-calling APIs and some vendors reject it.
  const parameters = { ...jsonSchema };
  delete parameters.$schema;
  return {
    name: tool.name,
    description: tool.description,
    parameters,
  };
}
