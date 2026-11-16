import { createTransport } from "nodemailer";
import type { Logger } from "../runtime.js";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Sends one email, or rejects. Injected so tests can capture mail instead of sending it. */
export type Mailer = (email: Email) => Promise<void>;

/**
 * Real delivery over SMTP, e.g. `smtps://user:pass@smtp.example.com:465`.
 * Nodemailer encodes headers itself, so values such as a monitor name cannot
 * inject extra headers into the message.
 */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = createTransport(smtpUrl);
  return async (email) => {
    await transport.sendMail({ from, to: email.to, subject: email.subject, text: email.text });
  };
}

/**
 * Development fallback when no SMTP server is configured: the email is
 * written to the log instead of being sent, so the alert flow can be seen
 * working without an email account. The recipient is not logged.
 */
export function createLogMailer(logger: Logger): Mailer {
  return (email) => {
    logger.info(
      { subject: email.subject, body: email.text },
      "email (not sent: SMTP_URL is unset)",
    );
    return Promise.resolve();
  };
}
