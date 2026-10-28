import { randomBytes } from "node:crypto";
import { ConflictError, AuthError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  UserModel,
  type SignupInput,
  type LoginInput,
  type ResetRequestInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from "./models";
import { hashPassword, verifyPassword } from "./password";
import {
  createSession,
  revokeSessionByToken,
  getSessionToken,
  clearSessionCookie,
  hashToken,
} from "./session";
import { getEmailSender } from "./email";

const RESET_TTL_MS = 1000 * 60 * 30; // 30 min
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Sign up. Returns the new user's id. Throws ConflictError if the email is
 * already registered (deliberately the ONLY case that reveals existence — on
 * the public signup form we must tell the user to use a different email).
 */
export async function signup(input: SignupInput): Promise<string> {
  const email = input.email.toLowerCase();
  const existing = await UserModel.findOne({ email }).lean();
  if (existing) {
    throw new ConflictError("An account with that email already exists");
  }

  const passwordHash = await hashPassword(input.password);
  const rawVerify = newToken();

  const user = await UserModel.create({
    email,
    passwordHash,
    displayName: input.displayName,
    role: "user",
    emailVerificationTokenHash: hashToken(rawVerify),
    emailVerificationExpiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  });

  const id = user._id.toString();

  // Send verification email (console sender in dev). Never log the raw token.
  await getEmailSender().send({
    to: email,
    subject: "Verify your ShopPilot email",
    text: `Verify your email: /verify-email?token=${rawVerify}`,
  });

  await createSession(id);
  logger.info("auth.signup", { userId: id });
  return id;
}

/**
 * Log in. Uses an IDENTICAL error for unknown email and wrong password so we
 * never reveal which emails are registered.
 */
export async function login(input: LoginInput): Promise<string> {
  const email = input.email.toLowerCase();
  const genericError = new AuthError("Invalid email or password");

  const user = await UserModel.findOne({ email }).lean();
  // Always run a verify to keep timing roughly constant, even if user missing.
  const hash =
    user?.passwordHash ?? "$argon2id$v=19$m=19456,t=2,p=1$invalidinvalid$invalid";
  const ok = await verifyPassword(hash, input.password);
  if (!user || !ok) {
    throw genericError;
  }

  await createSession(user._id.toString());
  logger.info("auth.login", { userId: user._id.toString() });
  return user._id.toString();
}

/** Log out: revoke the current session and clear the cookie. */
export async function logout(): Promise<void> {
  const raw = await getSessionToken();
  if (raw) await revokeSessionByToken(raw);
  await clearSessionCookie();
}

/** Verify an email via one-time token. Idempotent-ish: already-verified is fine. */
export async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  const user = await UserModel.findOne({
    emailVerificationTokenHash: hashToken(input.token),
    emailVerificationExpiresAt: { $gt: new Date() },
  });

  if (!user) throw new AuthError("Invalid or expired verification token");

  user.emailVerifiedAt = new Date();
  user.emailVerificationTokenHash = null;
  user.emailVerificationExpiresAt = null;
  await user.save();
  logger.info("auth.email_verified", { userId: user._id.toString() });
}

/**
 * Request a password reset. ALWAYS resolves without error (even for unknown
 * emails) so the endpoint can't be used to enumerate registered accounts.
 */
export async function requestPasswordReset(input: ResetRequestInput): Promise<void> {
  const email = input.email.toLowerCase();
  const user = await UserModel.findOne({ email });

  if (!user) {
    // Log but do not reveal; still "succeed" from the caller's perspective.
    logger.info("auth.reset_request_unknown", {});
    return;
  }

  const raw = newToken();
  user.passwordResetTokenHash = hashToken(raw);
  user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL_MS);
  await user.save();

  await getEmailSender().send({
    to: email,
    subject: "Reset your ShopPilot password",
    text: `Reset your password: /reset-password?token=${raw}`,
  });
}

/** Complete a password reset via one-time token. Invalidates existing sessions. */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const user = await UserModel.findOne({
    passwordResetTokenHash: hashToken(input.token),
    passwordResetExpiresAt: { $gt: new Date() },
  });

  if (!user) throw new AuthError("Invalid or expired reset token");

  user.passwordHash = await hashPassword(input.password);
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  await user.save();

  // Revoke all existing sessions for safety after a credential change.
  const { SessionModel } = await import("./models");
  await SessionModel.updateMany(
    { userId: user._id },
    { $set: { revokedAt: new Date() } },
  );

  logger.info("auth.password_reset", { userId: user._id.toString() });
}
