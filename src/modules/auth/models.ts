import {
  Schema,
  model,
  models,
  type InferSchemaType,
  type Model,
  type Types,
} from "mongoose";
import { z } from "zod";

/**
 * User + Session (auth) Mongoose models with paired Zod schemas.
 *
 * Each Mongoose schema has a matching Zod schema used to validate inbound data
 * (signup/reset payloads). The TS types are inferred from the Mongoose schema so
 * runtime and types never drift. Note: auth `Session` here is a LOGIN session —
 * distinct from chat sessions, which arrive in Phase 4.
 */

// ---- Zod (validation) -----------------------------------------------------

export const roleSchema = z.enum(["user", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const MIN_PASSWORD_LENGTH = 8;

export const signupInputSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    ),
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required")
    .max(80, "Display name is too long"),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

export const loginInputSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const resetRequestInputSchema = z.object({
  email: z.email("Enter a valid email address"),
});
export type ResetRequestInput = z.infer<typeof resetRequestInputSchema>;

export const resetPasswordInputSchema = z.object({
  token: z.string().min(10, "Invalid reset token"),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    ),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

export const verifyEmailInputSchema = z.object({
  token: z.string().min(10, "Invalid verification token"),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailInputSchema>;

// ---- Mongoose (persistence) ----------------------------------------------

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    emailVerifiedAt: { type: Date, default: null },
    // Hashed one-time tokens for verification + password reset (raw never stored).
    emailVerificationTokenHash: { type: String, default: null },
    emailVerificationExpiresAt: { type: Date, default: null },
    passwordResetTokenHash: { type: String, default: null },
    passwordResetExpiresAt: { type: Date, default: null },
    // Shopping preferences only — never card or address data (per the prompt).
    preferences: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // SHA-256 of the session token. The raw token only ever lives in the cookie.
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true },
);

// Auto-expire stale auth sessions via a TTL index (cleanup is opportunistic).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };

// Guard against OverwriteModelError under HMR / repeated imports in tests.
export const UserModel: Model<UserDoc> =
  (models.User as Model<UserDoc>) || model<UserDoc>("User", userSchema);
export const SessionModel: Model<SessionDoc> =
  (models.Session as Model<SessionDoc>) || model<SessionDoc>("Session", sessionSchema);
