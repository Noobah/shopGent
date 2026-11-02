import { env } from "@/lib/env";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  budgetResultSchema,
  computeBudget,
  parseBudgetPaise,
  type BudgetResult,
  type CartLine,
} from "@/modules/budget";
import {
  getLLMProvider,
  type FinishReason,
  type LLMMessage,
  type LLMProvider,
  type ToolCall,
} from "@/modules/llm";
import {
  getProductSource,
  getTrustPolicy,
  type Product,
  type ProductSource,
  type TrustPolicy,
} from "@/modules/products";
import {
  appendMessageForUser,
  appendToolTraceForUser,
  cartLinesSchema,
  getChatSessionForUser,
  getOrCreateCartForUser,
  listMessagesForUser,
  updateChatSessionForUser,
  type CartItem,
  type ChatSessionDoc,
  type MessageDoc,
} from "@/modules/sessions";
import { toCartView, type CartView } from "./cart";
import { buildFallbackAnswer } from "./fallback";
import type { AgentDoneStatus, AgentEvent } from "./events";
import { buildRegenerationPrompt, buildSystemPrompt } from "./prompts";
import { reserveAgentStep } from "./rateLimit";
import { AGENT_TOOL_DEFINITIONS, invokeTool, parseToolInput } from "./tools";
import { searchOutputSchema } from "./tools/products";
import { toToolErrorPayload, type ToolContext } from "./tools/types";
import { extractToolPayload, wrapToolResult } from "./untrusted";
import { verifyFinalAnswer } from "./verify";

/**
 * The agent loop.
 *
 * One request = at most `maxSteps` LLM turns. Each turn:
 *   1. reserve a daily step + persist the session counter
 *   2. call the provider with the system prompt, history and tool schemas
 *   3. if it asks for tools: validate input/output, execute, persist the
 *      assistant turn + every tool trace/message + cart before continuing
 *   4. if it writes a final answer: verify every number/name/URL, regenerate
 *      once when needed, then persist and stream it
 *
 * The loop yields AgentEvent objects. The SSE route is a dumb pipe; tests can
 * consume the same generator without HTTP.
 */

const MAX_HISTORY_MESSAGES = 60;
const FINAL_TEXT_CHUNK_SIZE = 200;

export interface RunAgentOptions {
  userId: string;
  sessionId: string;
  userMessage: string;
  signal?: AbortSignal;
  llm?: LLMProvider;
  productSource?: ProductSource;
  trustPolicy?: TrustPolicy;
  /** Override the 8-turn cap (tests). */
  maxSteps?: number;
  /** Override the per-user daily step cap (tests). */
  dailyStepCap?: number;
  now?: () => Date;
}

export interface AgentRunSummary {
  status: AgentDoneStatus;
  steps: number;
  finalText: string;
  cart: CartView;
  handoffId?: string;
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent, AgentRunSummary> {
  const now = options.now ?? (() => new Date());
  const maxSteps = options.maxSteps ?? env.AGENT_MAX_STEPS;
  const dailyStepCap = options.dailyStepCap ?? env.AGENT_DAILY_STEPS;
  const llm = options.llm ?? getLLMProvider();
  const productSource = options.productSource ?? getProductSource();
  const trustPolicy = options.trustPolicy ?? getTrustPolicy();
  const signal = options.signal;

  let session: ChatSessionDoc | null = null;
  let cartItems: CartItem[] = [];
  let stepCount = 0;
  let finalStatus: AgentDoneStatus | null = null;
  let finalText = "";
  let handoffBuilt: { id: string; budget: BudgetResult } | null = null;
  let lastBudget: BudgetResult | null = null;
  let lastSearchResults: Product[] = [];
  const toolPayloads: unknown[] = [];

  let summary: AgentRunSummary = {
    status: "error",
    steps: 0,
    finalText: "",
    cart: emptyCartView(options.sessionId),
  };

  // A client can disconnect before the first DB read. Stop before persisting a
  // user message that was never processed.
  if (signal?.aborted) {
    summary = {
      status: "aborted",
      steps: 0,
      finalText: "",
      cart: emptyCartView(options.sessionId),
    };
    yield { type: "status", status: "aborted", step: 0 };
    yield {
      type: "done",
      sessionId: options.sessionId,
      status: "aborted",
      steps: 0,
      cart: summary.cart,
    };
    return summary;
  }

  try {
    // ---- load + budget ----------------------------------------------------
    session = await getChatSessionForUser(options.userId, options.sessionId);
    if (!session) throw new NotFoundError("Chat session not found");

    const cart = await getOrCreateCartForUser(options.userId, options.sessionId);
    if (!cart) throw new NotFoundError("Chat session not found");
    cartItems = cartLinesSchema.parse(cart.lines);

    // The user's message is the ONLY source of a budget change. Code parses it.
    const parsedBudget = parseBudgetPaise(options.userMessage);
    if (parsedBudget !== null && parsedBudget !== session.budgetPaise) {
      const updated = await updateChatSessionForUser(options.userId, options.sessionId, {
        budgetPaise: parsedBudget,
      });
      if (!updated) throw new NotFoundError("Chat session not found");
      session = updated;
    }

    // Persist the user turn before doing any model work.
    await appendMessageForUser(options.userId, options.sessionId, {
      role: "user",
      content: options.userMessage,
    });

    const history = await listMessagesForUser(options.userId, options.sessionId);
    for (const message of history) {
      if (message.role !== "tool") continue;
      const data = unwrapEnvelope(extractToolPayload(message.content));
      if (data !== null) toolPayloads.push(data);
    }
    lastBudget = findLastBudget(toolPayloads);
    lastSearchResults = findLastSearchResults(toolPayloads);

    const llmMessages = trimHistory(history.map(toLlmMessage));

    const toolContext: ToolContext = {
      userId: options.userId,
      sessionId: options.sessionId,
      session,
      cartItems,
      productSource,
      trustPolicy,
      signal,
      now,
    };

    yield {
      type: "status",
      status: "started",
      step: 0,
      sessionId: options.sessionId,
      message: "Loading your session.",
    };
    yield {
      type: "cart_update",
      cart: toCartView(options.sessionId, cartItems),
    };

    let finished = false;

    while (stepCount < maxSteps) {
      if (signal?.aborted) {
        finalStatus = "aborted";
        break;
      }

      const reservation = await reserveAgentStep(options.userId, {
        now: now(),
        cap: dailyStepCap,
      });
      if (!reservation.allowed) {
        yield {
          type: "error",
          code: "RATE_LIMITED",
          message: `Daily agent step limit reached (${reservation.cap}). Try again tomorrow.`,
          recoverable: false,
        };
        finalStatus = "error";
        break;
      }

      stepCount += 1;
      const stepped = await updateChatSessionForUser(options.userId, options.sessionId, {
        incrementStep: true,
      });
      if (!stepped) throw new NotFoundError("Chat session not found");
      session = stepped;
      toolContext.session = session;

      yield { type: "status", status: "thinking", step: stepCount };

      const currentCart = toCartView(options.sessionId, cartItems);
      const messages: LLMMessage[] = [
        {
          role: "system",
          content: buildSystemPrompt({
            budgetPaise:
              typeof session.budgetPaise === "number" ? session.budgetPaise : null,
            cartItemCount: currentCart.itemCount,
            cartSubtotalPaise: currentCart.subtotalPaise,
            flatShippingPaise:
              typeof session.flatShippingPaise === "number"
                ? session.flatShippingPaise
                : null,
            taxRatePercent:
              typeof session.taxRatePercent === "number" ? session.taxRatePercent : null,
            handoffId: session.lastHandoffId?.toString() ?? null,
            maxSteps,
          }),
        },
        ...llmMessages,
      ];

      let turnText = "";
      const turnToolCalls: ToolCall[] = [];
      let finishReason: FinishReason | null = null;
      let streamError: unknown = null;

      try {
        for await (const event of llm.chat({
          messages,
          tools: AGENT_TOOL_DEFINITIONS,
          signal,
          temperature: 0.2,
          maxTokens: 1_500,
        })) {
          if (signal?.aborted) break;
          switch (event.type) {
            case "text_delta":
              turnText += event.delta;
              break;
            case "tool_call":
              turnToolCalls.push(event.toolCall);
              break;
            case "finish":
              finishReason = event.reason;
              break;
            case "usage":
              // Usage is logged by adapters; the loop does not bill tokens.
              break;
          }
        }
      } catch (err) {
        streamError = err;
      }

      if (signal?.aborted) {
        finalStatus = "aborted";
        break;
      }
      if (streamError || finishReason === "error") {
        logger.error("agent.llm_failed", { err: streamError });
        yield {
          type: "error",
          code: "LLM_ERROR",
          message: "The language model request failed. Please try again.",
          recoverable: true,
        };
        finalStatus = "error";
        break;
      }
      if (finishReason === "content_filter") {
        yield {
          type: "error",
          code: "CONTENT_FILTER",
          message: "The language model declined to answer this request.",
          recoverable: false,
        };
        finalStatus = "error";
        break;
      }

      // ---- final answer ---------------------------------------------------
      if (turnToolCalls.length === 0) {
        let candidate = turnText;
        yield { type: "status", status: "verifying", step: stepCount };

        let verification = verifyFinalAnswer({
          text: candidate,
          budgetPaise:
            typeof session.budgetPaise === "number" ? session.budgetPaise : null,
          toolPayloads,
        });

        if (!verification.ok && stepCount < maxSteps) {
          const regenReservation = await reserveAgentStep(options.userId, {
            now: now(),
            cap: dailyStepCap,
          });
          if (regenReservation.allowed) {
            stepCount += 1;
            const regenStepped = await updateChatSessionForUser(
              options.userId,
              options.sessionId,
              { incrementStep: true },
            );
            if (!regenStepped) throw new NotFoundError("Chat session not found");
            session = regenStepped;
            toolContext.session = session;

            yield { type: "status", status: "regenerating", step: stepCount };

            try {
              let regenerated = "";
              for await (const event of llm.chat({
                messages: [
                  ...messages,
                  { role: "assistant", content: turnText || null },
                  {
                    role: "system",
                    content: buildRegenerationPrompt(verification.violations),
                  },
                ],
                signal,
                temperature: 0.1,
                maxTokens: 1_200,
              })) {
                if (signal?.aborted) break;
                if (event.type === "text_delta") regenerated += event.delta;
              }

              if (!signal?.aborted && regenerated.trim()) {
                verification = verifyFinalAnswer({
                  text: regenerated,
                  budgetPaise:
                    typeof session.budgetPaise === "number" ? session.budgetPaise : null,
                  toolPayloads,
                });
                if (verification.ok) candidate = regenerated;
              }
            } catch (err) {
              logger.warn("agent.regeneration_failed", { err });
            }
          }
        }

        if (signal?.aborted) {
          finalStatus = "aborted";
          break;
        }

        if (!verification.ok) {
          candidate = buildFallbackAnswer({
            reason: "verification_failed",
            budgetPaise:
              typeof session.budgetPaise === "number" ? session.budgetPaise : null,
            cart: toCartView(options.sessionId, cartItems),
            budget: freshBudget(session, cartItems) ?? lastBudget,
            handoffId: handoffBuilt?.id ?? null,
            searchResults: lastSearchResults,
          });
        }

        finalText = candidate.trim() || "I couldn't verify an answer for this request.";
        finalStatus = handoffBuilt ? "handoff_ready" : "completed";
        finished = true;
        break;
      }

      // ---- tool-call turn -------------------------------------------------
      const messageToolCalls = turnToolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      }));
      await appendMessageForUser(options.userId, options.sessionId, {
        role: "assistant",
        content: turnText.trim() ? turnText : null,
        toolCalls: messageToolCalls,
      });
      llmMessages.push({
        role: "assistant",
        content: turnText.trim() ? turnText : null,
        toolCalls: turnToolCalls,
      });

      for (let callIndex = 0; callIndex < turnToolCalls.length; callIndex += 1) {
        const call = turnToolCalls[callIndex]!;
        if (signal?.aborted) {
          await appendAbortedToolMessages(
            options.userId,
            options.sessionId,
            turnToolCalls.slice(callIndex),
            llmMessages,
          );
          finalStatus = "aborted";
          break;
        }

        const parsedInput = parseToolInput(call.input);
        yield {
          type: "status",
          status: "tool_running",
          step: stepCount,
          message: `Running ${call.name}.`,
        };
        yield {
          type: "tool_start",
          step: stepCount,
          callId: call.id,
          tool: call.name,
          input: parsedInput,
        };

        const startedAt = Date.now();
        try {
          const result = await invokeTool(call.name, toolContext, call.input);
          const durationMs = Math.max(0, Date.now() - startedAt);

          if (result.cartItems) {
            cartItems = result.cartItems;
            toolContext.cartItems = cartItems;
          }
          if (result.budget) lastBudget = result.budget;
          if (result.handoff) {
            handoffBuilt = result.handoff;
            lastBudget = result.handoff.budget;
          }
          if (call.name === "search_products") {
            const parsedSearch = searchOutputSchema.safeParse(result.output);
            if (parsedSearch.success) lastSearchResults = parsedSearch.data.products;
          }
          toolPayloads.push(result.output);

          yield {
            type: "tool_result",
            step: stepCount,
            callId: call.id,
            tool: call.name,
            ok: true,
            result: result.output,
            durationMs,
          };
          if (result.cartItems) {
            yield {
              type: "cart_update",
              cart: toCartView(options.sessionId, result.cartItems),
            };
          }
          if (result.handoff) {
            yield {
              type: "handoff_ready",
              handoffId: result.handoff.id,
              budget: result.handoff.budget,
            };
          }

          await appendToolTraceForUser(options.userId, options.sessionId, {
            step: stepCount,
            callId: call.id,
            tool: call.name,
            input: parsedInput,
            output: result.output,
            ok: true,
            durationMs,
          });

          const toolContent = wrapToolResult(call.name, {
            ok: true,
            tool: call.name,
            data: result.output,
          });
          await appendMessageForUser(options.userId, options.sessionId, {
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
          });
          llmMessages.push({
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
          });
        } catch (err) {
          const durationMs = Math.max(0, Date.now() - startedAt);
          const error = toToolErrorPayload(err);
          logger.warn("agent.tool_failed", {
            tool: call.name,
            code: error.code,
            err,
          });

          yield {
            type: "tool_result",
            step: stepCount,
            callId: call.id,
            tool: call.name,
            ok: false,
            error,
            durationMs,
          };

          await appendToolTraceForUser(options.userId, options.sessionId, {
            step: stepCount,
            callId: call.id,
            tool: call.name,
            input: parsedInput,
            output: null,
            ok: false,
            errorCode: error.code,
            errorMessage: error.message,
            durationMs,
          });

          const toolContent = wrapToolResult(call.name, {
            ok: false,
            tool: call.name,
            error,
          });
          await appendMessageForUser(options.userId, options.sessionId, {
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
          });
          llmMessages.push({
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
          });

          if (signal?.aborted || error.code === "ABORTED") {
            await appendAbortedToolMessages(
              options.userId,
              options.sessionId,
              turnToolCalls.slice(callIndex + 1),
              llmMessages,
            );
            finalStatus = "aborted";
            break;
          }
        }
      }

      if (finalStatus) break;
      // The next while iteration asks the model to interpret the tool results.
    }

    if (!finished && finalStatus === null) {
      finalStatus = "limit_reached";
      finalText = buildFallbackAnswer({
        reason: "step_limit",
        budgetPaise:
          typeof session?.budgetPaise === "number" ? session.budgetPaise : null,
        cart: toCartView(options.sessionId, cartItems),
        budget: session ? (freshBudget(session, cartItems) ?? lastBudget) : lastBudget,
        handoffId: handoffBuilt?.id ?? null,
        searchResults: lastSearchResults,
      });
      yield { type: "status", status: "limit_reached", step: stepCount };
    }

    const finalCart = safeCartView(options.sessionId, cartItems);

    if (finalStatus === "aborted") {
      yield { type: "status", status: "aborted", step: stepCount };
      summary = {
        status: "aborted",
        steps: stepCount,
        finalText: "",
        cart: finalCart,
      };
      yield {
        type: "done",
        sessionId: options.sessionId,
        status: "aborted",
        steps: stepCount,
        cart: finalCart,
      };
      return summary;
    }

    if (finalStatus === "error") {
      summary = {
        status: "error",
        steps: stepCount,
        finalText: "",
        cart: finalCart,
      };
      yield {
        type: "done",
        sessionId: options.sessionId,
        status: "error",
        steps: stepCount,
        cart: finalCart,
      };
      return summary;
    }

    if (!finalStatus) {
      finalStatus = "completed";
    }

    // Persist the verified final answer exactly once, then stream it.
    if (signal?.aborted) {
      summary = {
        status: "aborted",
        steps: stepCount,
        finalText: "",
        cart: finalCart,
      };
      yield { type: "status", status: "aborted", step: stepCount };
      yield {
        type: "done",
        sessionId: options.sessionId,
        status: "aborted",
        steps: stepCount,
        cart: finalCart,
      };
      return summary;
    }

    if (!finalText) {
      finalText = buildFallbackAnswer({
        reason: "verification_failed",
        budgetPaise:
          typeof session?.budgetPaise === "number" ? session.budgetPaise : null,
        cart: finalCart,
        budget: session ? (freshBudget(session, cartItems) ?? lastBudget) : lastBudget,
        handoffId: handoffBuilt?.id ?? null,
        searchResults: lastSearchResults,
      });
    }

    await appendMessageForUser(options.userId, options.sessionId, {
      role: "assistant",
      content: finalText,
    });

    for (const chunk of splitText(finalText, FINAL_TEXT_CHUNK_SIZE)) {
      yield { type: "message_delta", delta: chunk };
    }

    yield { type: "status", status: finalStatus, step: stepCount };

    summary = {
      status: finalStatus,
      steps: stepCount,
      finalText,
      cart: finalCart,
      ...(handoffBuilt ? { handoffId: handoffBuilt.id } : {}),
    };
    yield {
      type: "done",
      sessionId: options.sessionId,
      status: finalStatus,
      steps: stepCount,
      cart: finalCart,
      ...(handoffBuilt ? { handoffId: handoffBuilt.id } : {}),
    };
    return summary;
  } catch (err) {
    logger.error("agent.run_failed", { err });
    const error =
      err instanceof AppError
        ? { code: err.code, message: err.expose ? err.message : "Agent failed" }
        : {
            code: isAbortError(err) ? "ABORTED" : "INTERNAL_ERROR",
            message: isAbortError(err)
              ? "The request was cancelled."
              : "The agent failed. Please try again.",
          };

    yield { type: "error", code: error.code, message: error.message, recoverable: false };

    summary = {
      status: error.code === "ABORTED" ? "aborted" : "error",
      steps: stepCount,
      finalText: "",
      cart: safeCartView(options.sessionId, cartItems),
    };
    yield {
      type: "done",
      sessionId: options.sessionId,
      status: summary.status,
      steps: stepCount,
      cart: summary.cart,
    };
    return summary;
  }
}

// ---- helpers -------------------------------------------------------------

/**
 * A disconnect can land between tool calls in one assistant turn. Every tool
 * call needs a matching tool message or the next LLM request is invalid, so
 * fill the unanswered calls with an ABORTED result.
 */
async function appendAbortedToolMessages(
  userId: string,
  sessionId: string,
  calls: ToolCall[],
  llmMessages: LLMMessage[],
): Promise<void> {
  for (const call of calls) {
    const content = wrapToolResult(call.name, {
      ok: false,
      tool: call.name,
      error: {
        code: "ABORTED",
        message: "The request was cancelled before this tool ran.",
      },
    });

    try {
      await appendMessageForUser(userId, sessionId, {
        role: "tool",
        content,
        toolCallId: call.id,
      });
    } catch (err) {
      logger.warn("agent.abort_tool_message_failed", { tool: call.name, err });
    }

    llmMessages.push({ role: "tool", content, toolCallId: call.id });
  }
}

function toLlmMessage(message: MessageDoc): LLMMessage {
  const toolCalls = (message.toolCalls ?? []).map((call) => ({
    id: call.id,
    name: call.name,
    input: call.input,
  }));

  return {
    role: message.role,
    content: message.content ?? null,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

/**
 * Keep the most recent turns, never starting with an orphaned tool message.
 * Tool calls/results stay paired because the cut moves forward past tool rows.
 */
function trimHistory(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  let start = messages.length - MAX_HISTORY_MESSAGES;
  while (start < messages.length && messages[start]?.role === "tool") {
    start += 1;
  }
  return messages.slice(start);
}

function unwrapEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.ok === false) return null;
  if ("data" in value) return value.data;
  return value;
}

function findLastBudget(payloads: unknown[]): BudgetResult | null {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (!isRecord(payload)) continue;
    const parsed = budgetResultSchema.safeParse(payload.budget);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function findLastSearchResults(payloads: unknown[]): Product[] {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const parsed = searchOutputSchema.safeParse(payloads[index]);
    if (parsed.success) return parsed.data.products;
  }
  return [];
}

function freshBudget(
  session: ChatSessionDoc,
  cartItems: CartItem[],
): BudgetResult | null {
  const budgetPaise =
    typeof session.budgetPaise === "number" ? session.budgetPaise : null;
  if (budgetPaise === null) return null;

  const lines: CartLine[] = cartItems.map((item) => ({
    productId: item.productId,
    title: item.title,
    quantity: item.quantity,
    unitPricePaise: item.unitPricePaise,
  }));

  try {
    return computeBudget({
      budgetPaise,
      lines,
      flatShippingPaise:
        typeof session.flatShippingPaise === "number" ? session.flatShippingPaise : null,
      taxRatePercent:
        typeof session.taxRatePercent === "number" ? session.taxRatePercent : undefined,
    });
  } catch (err) {
    logger.warn("agent.fresh_budget_failed", { err });
    return null;
  }
}

function safeCartView(sessionId: string, lines: CartItem[]): CartView {
  try {
    return toCartView(sessionId, lines);
  } catch (err) {
    logger.warn("agent.cart_view_failed", { err });
    return emptyCartView(sessionId);
  }
}

function emptyCartView(sessionId: string): CartView {
  return {
    sessionId,
    itemCount: 0,
    subtotalPaise: 0,
    lines: [],
  };
}

function splitText(text: string, size: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError")
  );
}
