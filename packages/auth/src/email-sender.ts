import nodemailer, { type Transporter } from "nodemailer";
import { TotalBaseError } from "@totalbase/errors";
import type { SecretsService } from "@totalbase/secrets";
import type { SettingsService } from "@totalbase/settings";

/**
 * Delivery abstraction used both for auth-related emails (invitation,
 * password reset, email verification) and for the Workflows `send-email`
 * operation (SendEmailModal.vue) - hence cc/bcc/replyTo/html on top of the
 * original {to, subject, body}.
 */
export interface EmailSendInput {
  to: string;
  subject: string;
  /** Plain-text body. At least one of body/html must be set. */
  body?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  /** Files sent with the message - a workflow's Send email step (Specification_Workflows.md §5.16). */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailSender {
  send(input: EmailSendInput): Promise<void>;
  /**
   * Connects to the relay and authenticates, sending nothing - the admin's
   * "Test connection" (Specification_Administration.md §8.1).
   */
  verify(): Promise<void>;
}

/** How long "Test connection" waits for the relay before failing. */
const SMTP_VERIFY_TIMEOUT_MS = 30_000;

/**
 * Real SMTP delivery via nodemailer, config-driven from the `smtp.*`
 * settings group (packages/settings/src/registry.ts) - read fresh on every
 * send (not cached at construction) so an admin changing them via
 * PATCH /admin/api/settings/smtp takes effect without a restart. The
 * password is never stored in Postgres in plaintext - `smtp.password_secret_key`
 * points at a @totalbase/secrets entry, decrypted only at send time.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
  ) {}

  /** A transport over the saved smtp.* settings, plus the sender address. */
  private async transport(): Promise<{ transport: Transporter; from: string }> {
    const [host, port, secure, username, passwordSecretKey, from] = await Promise.all([
      this.settings.get("smtp.host"),
      this.settings.get("smtp.port"),
      this.settings.get("smtp.secure"),
      this.settings.get("smtp.username"),
      this.settings.get("smtp.password_secret_key"),
      this.settings.get("smtp.from"),
    ]);
    if (!host || !from) {
      throw new TotalBaseError(
        "SMTP_NOT_CONFIGURED",
        "SMTP is not configured (smtp.host/smtp.from) - set it under Settings › SMTP before sending email.",
      );
    }
    const password = passwordSecretKey ? await this.secrets.decrypt(passwordSecretKey) : undefined;
    return {
      from,
      transport: nodemailer.createTransport({
        host,
        port,
        secure,
        auth: username ? { user: username, pass: password ?? "" } : undefined,
      }),
    };
  }

  async send(input: EmailSendInput): Promise<void> {
    const { transport, from } = await this.transport();
    try {
      await transport.sendMail({
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.body,
        html: input.html,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      });
    } catch (err) {
      throw new TotalBaseError(
        "EMAIL_SEND_FAILED",
        `The SMTP server did not accept the message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async verify(): Promise<void> {
    const { transport } = await this.transport();
    let timer: NodeJS.Timeout | undefined;
    try {
      // Connects, upgrades to TLS when offered and authenticates when
      // credentials are set - then QUITs without a MAIL FROM. Bounded as a
      // whole: nodemailer's own timeouts (2 min to connect, then 30 s for the
      // greeting) leave an admin waiting far too long on a wrong host/port.
      await Promise.race([
        transport.verify(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${SMTP_VERIFY_TIMEOUT_MS / 1000} s`)),
            SMTP_VERIFY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      throw new TotalBaseError(
        "SMTP_CONNECTION_FAILED",
        `Could not connect to the SMTP server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      transport.close();
    }
  }
}
