import { isValidObjectId } from "mongoose";
import { NotFoundError } from "@/lib/errors";
import {
  AgentUsageModel,
  CartModel,
  ChatSessionModel,
  HandoffModel,
  MessageModel,
  ToolTraceModel,
  agentUsageDaySchema,
  appendMessageInputSchema,
  cartLinesSchema,
  chatSessionCreateSchema,
  handoffCreateSchema,
  toolTraceCreateSchema,
  type AgentUsageDoc,
  type AppendMessageInput,
  type CartDoc,
  type CartItem,
  type ChatSessionCreateInput,
  type ChatSessionDoc,
  type HandoffCreateInput,
  type HandoffDoc,
  type MessageDoc,
  type ToolTraceCreateInput,
  type ToolTraceDoc,
} from "./models";
import { z } from "zod";

/**
 * Ownership-scoped repositories for chat sessions.
 *
 * EVERY read/write filters on `{ userId, sessionId }`. There is no
 * `getById(id)` escape hatch: a caller cannot accidentally fetch another user's
 * session because the only functions available require the owner id. A mismatch
 * returns null, which routes turn into 404 (never 403).
 */

function asObjectId(id: string): string | null {
  return isValidObjectId(id) ? id : null;
}

// ---- chat sessions -------------------------------------------------------

export async function createChatSession(
  userId: string,
  input: ChatSessionCreateInput,
): Promise<ChatSessionDoc> {
  const parsed = chatSessionCreateSchema.parse(input);
  const doc = await ChatSessionModel.create({
    userId,
    title: parsed.title,
    budgetPaise: parsed.budgetPaise ?? null,
  });
  return doc.toObject() as ChatSessionDoc;
}

/** The only way to fetch a chat session by id. Ownership is part of the query. */
export async function getChatSessionForUser(
  userId: string,
  sessionId: string,
): Promise<ChatSessionDoc | null> {
  if (!asObjectId(sessionId)) return null;
  return ChatSessionModel.findOne({ _id: sessionId, userId }).lean();
}

/** List a user's sessions, newest first (used by the history UI in Phase 5). */
export async function listChatSessionsForUser(
  userId: string,
  options: { limit?: number } = {},
): Promise<ChatSessionDoc[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return ChatSessionModel.find({ userId }).sort({ updatedAt: -1 }).limit(limit).lean();
}

const chatSessionPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  budgetPaise: z.number().int().positive().nullable().optional(),
  flatShippingPaise: z.number().int().min(0).nullable().optional(),
  taxRatePercent: z.number().min(0).max(100).nullable().optional(),
  status: z.enum(["active", "handoff_ready"]).optional(),
  lastMessageAt: z.date().nullable().optional(),
  lastHandoffId: z.string().min(1).nullable().optional(),
  /** Increment the completed-LLM-turn counter in the same atomic update. */
  incrementStep: z.boolean().optional(),
});

export type ChatSessionPatch = z.infer<typeof chatSessionPatchSchema>;

/** Update a session (ownership-scoped). Returns null when not owned/found. */
export async function updateChatSessionForUser(
  userId: string,
  sessionId: string,
  patch: ChatSessionPatch,
): Promise<ChatSessionDoc | null> {
  if (!asObjectId(sessionId)) return null;
  const parsed = chatSessionPatchSchema.parse(patch);

  const $set: Record<string, unknown> = {};
  if (parsed.title !== undefined) $set.title = parsed.title;
  if (parsed.budgetPaise !== undefined) $set.budgetPaise = parsed.budgetPaise;
  if (parsed.flatShippingPaise !== undefined) {
    $set.flatShippingPaise = parsed.flatShippingPaise;
  }
  if (parsed.taxRatePercent !== undefined) $set.taxRatePercent = parsed.taxRatePercent;
  if (parsed.status !== undefined) $set.status = parsed.status;
  if (parsed.lastMessageAt !== undefined) $set.lastMessageAt = parsed.lastMessageAt;
  if (parsed.lastHandoffId !== undefined) {
    $set.lastHandoffId = parsed.lastHandoffId;
  }

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length > 0) update.$set = $set;
  if (parsed.incrementStep) update.$inc = { stepCount: 1 };
  if (Object.keys(update).length === 0) {
    return getChatSessionForUser(userId, sessionId);
  }

  return ChatSessionModel.findOneAndUpdate({ _id: sessionId, userId }, update, {
    returnDocument: "after",
  }).lean();
}

// ---- messages ------------------------------------------------------------

/**
 * Append a message and allocate its sequence atomically.
 *
 * `messageCount` lives on the session, so two concurrent writers can never
 * claim the same sequence. Persistence after every step is the loop's job; this
 * function only guarantees the write itself is safe.
 */
export async function appendMessageForUser(
  userId: string,
  sessionId: string,
  input: AppendMessageInput,
): Promise<MessageDoc> {
  if (!asObjectId(sessionId)) throw new NotFoundError("Chat session not found");
  const parsed = appendMessageInputSchema.parse(input);

  const session = await ChatSessionModel.findOneAndUpdate(
    { _id: sessionId, userId },
    { $inc: { messageCount: 1 }, $set: { lastMessageAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  if (!session) throw new NotFoundError("Chat session not found");

  const doc = await MessageModel.create({
    userId,
    sessionId,
    role: parsed.role,
    content: parsed.content,
    ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
    toolCallId: parsed.toolCallId ?? null,
    sequence: session.messageCount,
  });
  return doc.toObject() as MessageDoc;
}

/** All messages in a session, oldest first (ownership baked in). */
export async function listMessagesForUser(
  userId: string,
  sessionId: string,
): Promise<MessageDoc[]> {
  if (!asObjectId(sessionId)) return [];
  return MessageModel.find({ userId, sessionId }).sort({ sequence: 1 }).lean();
}

// ---- cart ----------------------------------------------------------------

/**
 * Fetch the session cart, creating an empty one on first use.
 *
 * The session-ownership check happens BEFORE the upsert, so a guessed session
 * id can never create a cart under another user's id.
 */
export async function getOrCreateCartForUser(
  userId: string,
  sessionId: string,
): Promise<CartDoc | null> {
  if (!asObjectId(sessionId)) return null;
  const session = await getChatSessionForUser(userId, sessionId);
  if (!session) return null;

  const existing = await CartModel.findOne({ userId, sessionId }).lean();
  if (existing) return existing;

  try {
    const created = await CartModel.create({ userId, sessionId, lines: [] });
    return created.toObject() as CartDoc;
  } catch (err) {
    // A concurrent request may have inserted the unique {userId, sessionId}
    // cart first; read the winner instead of failing the request.
    if (isDuplicateKey(err)) {
      return CartModel.findOne({ userId, sessionId }).lean();
    }
    throw err;
  }
}

export async function getCartForUser(
  userId: string,
  sessionId: string,
): Promise<CartDoc | null> {
  if (!asObjectId(sessionId)) return null;
  return CartModel.findOne({ userId, sessionId }).lean();
}

/** Replace the cart lines atomically (ownership-scoped). */
export async function replaceCartLinesForUser(
  userId: string,
  sessionId: string,
  lines: CartItem[],
): Promise<CartDoc | null> {
  if (!asObjectId(sessionId)) return null;
  const parsed = cartLinesSchema.parse(lines);

  const session = await getChatSessionForUser(userId, sessionId);
  if (!session) return null;

  return CartModel.findOneAndUpdate(
    { userId, sessionId },
    { $set: { lines: parsed } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

// ---- tool traces ---------------------------------------------------------

export async function appendToolTraceForUser(
  userId: string,
  sessionId: string,
  input: ToolTraceCreateInput,
): Promise<ToolTraceDoc> {
  if (!asObjectId(sessionId)) throw new NotFoundError("Chat session not found");
  const parsed = toolTraceCreateSchema.parse(input);

  // Ownership check before the insert: a foreign session must look missing.
  const session = await getChatSessionForUser(userId, sessionId);
  if (!session) throw new NotFoundError("Chat session not found");

  const doc = await ToolTraceModel.create({ userId, sessionId, ...parsed });
  return doc.toObject() as ToolTraceDoc;
}

export async function listToolTracesForUser(
  userId: string,
  sessionId: string,
): Promise<ToolTraceDoc[]> {
  if (!asObjectId(sessionId)) return [];
  return ToolTraceModel.find({ userId, sessionId }).sort({ createdAt: 1 }).lean();
}

// ---- handoffs ------------------------------------------------------------

export async function createHandoffForUser(
  userId: string,
  sessionId: string,
  input: HandoffCreateInput,
): Promise<HandoffDoc> {
  if (!asObjectId(sessionId)) throw new NotFoundError("Chat session not found");
  const parsed = handoffCreateSchema.parse(input);

  const session = await getChatSessionForUser(userId, sessionId);
  if (!session) throw new NotFoundError("Chat session not found");

  const doc = await HandoffModel.create({
    userId,
    sessionId,
    status: parsed.status,
    budget: parsed.budget,
    lines: parsed.lines,
    note: parsed.note,
  });

  await ChatSessionModel.updateOne(
    { _id: sessionId, userId },
    {
      $set: {
        lastHandoffId: doc._id,
        status: "handoff_ready",
      },
    },
  );

  return doc.toObject() as HandoffDoc;
}

export async function getHandoffForUser(
  userId: string,
  handoffId: string,
): Promise<HandoffDoc | null> {
  if (!asObjectId(handoffId)) return null;
  return HandoffModel.findOne({ _id: handoffId, userId }).lean();
}

export async function listHandoffsForUser(
  userId: string,
  sessionId?: string,
): Promise<HandoffDoc[]> {
  const filter: Record<string, unknown> = { userId };
  if (sessionId) {
    if (!asObjectId(sessionId)) return [];
    filter.sessionId = sessionId;
  }
  return HandoffModel.find(filter).sort({ createdAt: -1 }).lean();
}

// ---- daily agent usage ---------------------------------------------------

/**
 * Atomically reserve one agent step for the user's UTC day.
 *
 * The increment happens first, so the cap is enforced across processes without
 * a read-modify-write race. A rejected reservation still consumed a slot; that
 * is intentional (it prevents a retry storm at the boundary).
 */
export async function reserveAgentStepForUser(
  userId: string,
  day: string,
  cap: number,
): Promise<{ allowed: boolean; used: number; day: string }> {
  const parsedDay = agentUsageDaySchema.parse(day);
  const doc = await AgentUsageModel.findOneAndUpdate(
    { userId, day: parsedDay },
    { $inc: { steps: 1 } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).lean();

  const used = doc?.steps ?? 1;
  return { allowed: used <= cap, used, day: parsedDay };
}

export async function getAgentUsageForUser(
  userId: string,
  day: string,
): Promise<AgentUsageDoc | null> {
  const parsedDay = agentUsageDaySchema.parse(day);
  return AgentUsageModel.findOne({ userId, day: parsedDay }).lean();
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- helpers -------------------------------------------------------------

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000
  );
}
