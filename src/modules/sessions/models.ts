import {
  Schema,
  model,
  models,
  type InferSchemaType,
  type Model,
  type Types,
} from "mongoose";
import { z } from "zod";
import { budgetResultSchema } from "@/modules/budget";

/**
 * Chat-session persistence models.
 *
 * Naming: `ChatSession` is a SHOPPING conversation. The auth `Session` model is
 * a LOGIN session and lives in modules/auth. Keeping the names distinct prevents
 * an accidental query against the wrong collection.
 *
 * Ownership rule: every document carries `userId`, and every repository query
 * filters on it. A mismatched user looks exactly like a missing row (404), never
 * a 403 that leaks existence.
 *
 * Money is integer paise everywhere. Product snapshots in carts/handoffs are
 * copied from the source at the time of the action so a later price change does
 * not silently rewrite history (Phase 6 re-verifies before the final bill).
 */

// ---- shared field schemas ------------------------------------------------

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const messageToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Raw JSON arguments string exactly as the provider emitted it. */
  input: z.string(),
});
export type MessageToolCall = z.infer<typeof messageToolCallSchema>;

export const cartItemSchema = z.object({
  productId: z.string().min(1),
  /** ProductSource id at the time this line was captured (e.g. "mock"). */
  source: z.string().min(1),
  title: z.string().min(1),
  brand: z.string().min(1),
  modelNumber: z.string().min(1),
  quantity: z.number().int().min(1).max(99),
  unitPricePaise: z.number().int().min(0),
  sellerName: z.string().min(1),
  isOfficialStore: z.boolean(),
  deliveryEstimate: z.string().min(1),
  url: z.string().url(),
  imageUrl: z.string().url(),
});
export type CartItem = z.infer<typeof cartItemSchema>;

export const cartLinesSchema = z.array(cartItemSchema).max(100);

export const chatSessionCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  budgetPaise: z.number().int().positive().nullable().optional(),
});
export type ChatSessionCreateInput = z.infer<typeof chatSessionCreateSchema>;

export const appendMessageInputSchema = z.object({
  role: chatRoleSchema,
  content: z.string().nullable().default(null),
  toolCalls: z.array(messageToolCallSchema).optional(),
  toolCallId: z.string().min(1).nullable().optional(),
});
export type AppendMessageInput = z.infer<typeof appendMessageInputSchema>;

export const toolTraceCreateSchema = z.object({
  step: z.number().int().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().optional(),
  ok: z.boolean(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  durationMs: z.number().int().min(0),
});
export type ToolTraceCreateInput = z.infer<typeof toolTraceCreateSchema>;

export const handoffStatusSchema = z.enum(["ready", "void"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffCreateSchema = z.object({
  status: handoffStatusSchema.default("ready"),
  budget: budgetResultSchema,
  lines: cartLinesSchema,
  /** Optional short note the agent attached to the bill. */
  note: z.string().max(500).nullable().default(null),
});
export type HandoffCreateInput = z.input<typeof handoffCreateSchema>;

export const agentUsageDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be a UTC YYYY-MM-DD string");

// ---- Mongoose schemas ----------------------------------------------------

const messageToolCallMongooseSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    input: { type: String, required: true },
  },
  { _id: false },
);

const cartItemMongooseSchema = new Schema(
  {
    productId: { type: String, required: true },
    source: { type: String, required: true },
    title: { type: String, required: true },
    brand: { type: String, required: true },
    modelNumber: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    unitPricePaise: { type: Number, required: true, min: 0 },
    sellerName: { type: String, required: true },
    isOfficialStore: { type: Boolean, required: true },
    deliveryEstimate: { type: String, required: true },
    url: { type: String, required: true },
    imageUrl: { type: String, required: true },
  },
  { _id: false },
);

const chatSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    // Set deterministically by parseBudgetPaise(), never by the LLM.
    budgetPaise: { type: Number, default: null, min: 0 },
    // Cart-level cost rules, explicitly supplied by the user/tool and reused
    // for every later budget check. `null` means "unknown" — never assumed free.
    flatShippingPaise: { type: Number, default: null, min: 0 },
    taxRatePercent: { type: Number, default: null, min: 0, max: 100 },
    status: {
      type: String,
      enum: ["active", "handoff_ready"],
      default: "active",
    },
    /** Monotonic message sequence allocator (atomic $inc). */
    messageCount: { type: Number, default: 0, min: 0 },
    /** Completed LLM turns in this session (display/diagnostics). */
    stepCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
    lastHandoffId: {
      type: Schema.Types.ObjectId,
      ref: "Handoff",
      default: null,
    },
  },
  { timestamps: true },
);

chatSessionSchema.index({ userId: 1, updatedAt: -1 });

const messageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["system", "user", "assistant", "tool"],
      required: true,
    },
    content: { type: String, default: null },
    toolCalls: { type: [messageToolCallMongooseSchema], default: undefined },
    toolCallId: { type: String, default: null },
    /** 1-based position inside the session; allocated atomically. */
    sequence: { type: Number, required: true, min: 1 },
  },
  { timestamps: true },
);

// Unique per session: two concurrent writers can never claim the same slot.
messageSchema.index({ userId: 1, sessionId: 1, sequence: 1 }, { unique: true });

const cartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
      index: true,
    },
    lines: { type: [cartItemMongooseSchema], default: [] },
  },
  { timestamps: true },
);

cartSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

const toolTraceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
      index: true,
    },
    step: { type: Number, required: true, min: 1 },
    callId: { type: String, required: true },
    tool: { type: String, required: true },
    /** Parsed input (validated by the tool schema before persistence). */
    input: { type: Schema.Types.Mixed, required: true },
    /** Parsed output; absent when the tool failed. */
    output: { type: Schema.Types.Mixed, default: null },
    ok: { type: Boolean, required: true },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    durationMs: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

toolTraceSchema.index({ userId: 1, sessionId: 1, createdAt: 1 });

const handoffSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
      index: true,
    },
    status: { type: String, enum: ["ready", "void"], default: "ready" },
    /** Immutable snapshot of the exact budget result the agent reported. */
    budget: { type: Schema.Types.Mixed, required: true },
    /** Cart lines frozen at handoff time (Phase 6 re-verifies prices separately). */
    lines: { type: [cartItemMongooseSchema], required: true },
    note: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

handoffSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

const agentUsageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** UTC day, YYYY-MM-DD. */
    day: { type: String, required: true },
    steps: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

agentUsageSchema.index({ userId: 1, day: 1 }, { unique: true });

// ---- inferred document types --------------------------------------------

export type ChatSessionDoc = InferSchemaType<typeof chatSessionSchema> & {
  _id: Types.ObjectId;
};
export type MessageDoc = InferSchemaType<typeof messageSchema> & {
  _id: Types.ObjectId;
};
export type CartDoc = InferSchemaType<typeof cartSchema> & {
  _id: Types.ObjectId;
};
export type ToolTraceDoc = InferSchemaType<typeof toolTraceSchema> & {
  _id: Types.ObjectId;
};
export type HandoffDoc = InferSchemaType<typeof handoffSchema> & {
  _id: Types.ObjectId;
};
export type AgentUsageDoc = InferSchemaType<typeof agentUsageSchema> & {
  _id: Types.ObjectId;
};

// ---- model guards (HMR / repeated imports in tests) ---------------------

export const ChatSessionModel: Model<ChatSessionDoc> =
  (models.ChatSession as Model<ChatSessionDoc>) ||
  model<ChatSessionDoc>("ChatSession", chatSessionSchema);

export const MessageModel: Model<MessageDoc> =
  (models.Message as Model<MessageDoc>) || model<MessageDoc>("Message", messageSchema);

export const CartModel: Model<CartDoc> =
  (models.Cart as Model<CartDoc>) || model<CartDoc>("Cart", cartSchema);

export const ToolTraceModel: Model<ToolTraceDoc> =
  (models.ToolTrace as Model<ToolTraceDoc>) ||
  model<ToolTraceDoc>("ToolTrace", toolTraceSchema);

export const HandoffModel: Model<HandoffDoc> =
  (models.Handoff as Model<HandoffDoc>) || model<HandoffDoc>("Handoff", handoffSchema);

export const AgentUsageModel: Model<AgentUsageDoc> =
  (models.AgentUsage as Model<AgentUsageDoc>) ||
  model<AgentUsageDoc>("AgentUsage", agentUsageSchema);
