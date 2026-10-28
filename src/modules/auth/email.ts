import { logger } from "@/lib/logger";

/**
 * Email delivery behind an interface.
 *
 * v1 dev uses a console logger sender (no real SMTP). Swap in a real provider
 * later by implementing `EmailSender` and changing `getEmailSender()` — no call
 * sites change. Emails carry one-time tokens; we never log the raw token.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Dev/test sender: prints to the structured logger instead of sending mail. */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    logger.info("email.console", {
      to: message.to,
      subject: message.subject,
      // Full body is intentionally omitted — it embeds a one-time token.
      preview: message.text.slice(0, 60),
    });
  }
}

let instance: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (!instance) instance = new ConsoleEmailSender();
  return instance;
}

export function setEmailSender(sender: EmailSender | null): void {
  instance = sender;
}
