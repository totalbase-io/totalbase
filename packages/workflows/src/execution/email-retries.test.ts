import { EmailSendError } from "@totalbase/auth";
import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it } from "vitest";
import { sendWithRetries } from "./email-handlers.js";

/** nodemailer's marks on an error (smtp-connection): what EmailSendError reads. */
const smtpError = (message: string, marks: Record<string, unknown>) => new EmailSendError(Object.assign(new Error(message), marks));

/**
 * Send email's retries (Workflows.md §5.16): only after a failure the relay certainly did not take, so a retry
 * is never a second copy of the message.
 */
describe("Send email retries", () => {
  const NO_WAIT = [0, 0, 0, 0, 0];
  const failing = (errors: unknown[]) => {
    let calls = 0;
    return { send: async () => { const error = errors[calls++]; if (error) throw error; }, calls: () => calls };
  };

  it("says a refusal is certain for a 4xx answer and for a connection that never reached a mail command", () => {
    expect(smtpError("451 try later", { responseCode: 451, code: "EMESSAGE", command: "DATA" }).notAccepted).toBe(true);
    expect(smtpError("421 busy", { responseCode: 421 }).notAccepted).toBe(true);
    expect(smtpError("connect ECONNREFUSED", { code: "ESOCKET", originalCode: "ECONNREFUSED", syscall: "connect", command: "CONN" }).notAccepted).toBe(true);
    expect(smtpError("getaddrinfo ENOTFOUND", { code: "EDNS", command: "CONN" }).notAccepted).toBe(true);
    expect(smtpError("Connection timeout", { code: "ETIMEDOUT", timeoutType: "CONNECT_TIMEOUT", command: "CONN" }).notAccepted).toBe(true);
    expect(smtpError("Greeting never received", { code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT", command: "CONN" }).notAccepted).toBe(true);
  });

  // Regression guard: these may have delivered the message (or will never be accepted) - retrying is a duplicate (or useless).
  it("never calls certain a dropped or silent session, nor a permanent refusal", () => {
    expect(smtpError("Timeout", { code: "ETIMEDOUT", timeoutType: "SOCKET_TIMEOUT", command: "CONN" }).notAccepted).toBe(false);
    expect(smtpError("Server closed the connection", { code: "ECONNECTION", command: "CONN" }).notAccepted).toBe(false);
    expect(smtpError("read ECONNRESET", { code: "ESOCKET", originalCode: "ECONNRESET", syscall: "read", command: "CONN" }).notAccepted).toBe(false);
    expect(smtpError("550 no such user", { responseCode: 550, code: "EENVELOPE" }).notAccepted).toBe(false);
    expect(smtpError("535 bad credentials", { responseCode: 535, code: "EAUTH" }).notAccepted).toBe(false);
    expect(new EmailSendError("something else").notAccepted).toBe(false);
  });

  it("sends again after a certain refusal, up to the retries asked, and reports the attempts", async () => {
    const temporary = smtpError("451 try later", { responseCode: 451 });
    const twice = failing([temporary, temporary]);
    expect(await sendWithRetries(twice.send, 3, undefined, NO_WAIT)).toBe(3);
    expect(twice.calls()).toBe(3);

    const always = failing([temporary, temporary, temporary, temporary]);
    await expect(sendWithRetries(always.send, 2, undefined, NO_WAIT)).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED", message: expect.stringContaining("after 3 attempts") });
    expect(always.calls()).toBe(3);
  });

  it("sends once without retries, and once whatever the retries when the outcome is uncertain or the failure is another", async () => {
    const temporary = failing([smtpError("451 try later", { responseCode: 451 })]);
    await expect(sendWithRetries(temporary.send, 0, undefined, NO_WAIT)).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
    expect(temporary.calls()).toBe(1);

    const uncertain = failing([smtpError("Timeout", { code: "ETIMEDOUT", timeoutType: "SOCKET_TIMEOUT" })]);
    await expect(sendWithRetries(uncertain.send, 5, undefined, NO_WAIT)).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
    expect(uncertain.calls()).toBe(1);

    const notConfigured = failing([new TotalBaseError("SMTP_NOT_CONFIGURED", "SMTP is not configured")]);
    await expect(sendWithRetries(notConfigured.send, 5, undefined, NO_WAIT)).rejects.toMatchObject({ code: "SMTP_NOT_CONFIGURED" });
    expect(notConfigured.calls()).toBe(1);
  });

  it("stops waiting when the run is cancelled", async () => {
    const controller = new AbortController();
    const temporary = failing([smtpError("451 try later", { responseCode: 451 }), undefined]);
    const pending = sendWithRetries(temporary.send, 5, controller.signal, [60_000]);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
    expect(temporary.calls()).toBe(1);
  });
});
