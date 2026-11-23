import { UUID_PATTERN } from "@totalbase/shared";
import { EmailSendError, fillMailPlaceholders, type EmailAttachment } from "@totalbase/auth";
import { TotalBaseError } from "@totalbase/errors";
import { assertFileReadAllowed, assertTemplateReadAllowed, type DataPrincipal } from "@totalbase/mutations";
import { templatePlaceholders } from "@totalbase/settings";
import type { WorkflowEngineContext } from "./context.js";
import type { OperationHandler } from "./types.js";


/**
 * A MAILING template's variables from the step's `data`: every nested field
 * by its dotted path (`customer.name`), scalars as text, objects and arrays as
 * JSON. A path with a null/undefined value is absent.
 */
export function flattenTemplateData(data: unknown, prefix = "", into: Record<string, string> = {}): Record<string, string> {
  if (data === null || data === undefined) return into;
  if (typeof data === "object") {
    if (prefix) into[prefix] = JSON.stringify(data);
    if (!Array.isArray(data)) {
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) flattenTemplateData(value, prefix ? `${prefix}.${key}` : key, into);
    }
    return into;
  }
  if (prefix) into[prefix] = String(data);
  return into;
}

/**
 * Renders a MAILING template (Workflows.md §5.16) with the
 * system emails' renderer: `{{path}}` placeholders in `subject` and
 * `message`, filled from `data`, HTML-escaped in the message. Every
 * placeholder must have a value - a missing one fails with
 * MISSING_TEMPLATE_VARIABLES rather than sending a blank.
 */
export function renderMailingTemplate(content: unknown, data: unknown): { subject: string; html: string } {
  const { subject, message } = (content ?? {}) as { subject?: unknown; message?: unknown };
  if (typeof subject !== "string" || typeof message !== "string") throw new TotalBaseError("TEMPLATE_WRONG_KIND", "This MAILING template has no subject or message.");
  const variables = flattenTemplateData(data);
  const missing = [...new Set([...templatePlaceholders(subject), ...templatePlaceholders(message)])].filter((name) => !(name in variables));
  if (missing.length) throw new TotalBaseError("MISSING_TEMPLATE_VARIABLES", `The template needs values for: ${missing.join(", ")}.`);
  return { subject: fillMailPlaceholders(subject, variables, false).trim(), html: fillMailPlaceholders(message, variables, true) };
}

/** At most this many files per message, together at most this many bytes - what a mail relay takes. */
export const SEND_EMAIL_MAX_ATTACHMENTS = 10;
export const SEND_EMAIL_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * The step's `attachments` - File ids, one or a list (a `{{create_file.data.asset}}`
 * resolves to one) - each read from storage after the executor's READ on it
 * is checked (a PUBLIC file needs none). Never a path, raw content or a URL.
 */
async function readAttachments(context: WorkflowEngineContext, dataPrincipal: DataPrincipal, value: unknown): Promise<EmailAttachment[]> {
  if (value === undefined || value === null || value === "") return [];
  const ids = (Array.isArray(value) ? value : [value]).filter((id) => id !== "" && id !== null);
  if (ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "Every attachment must resolve to a File id.");
  }
  if (ids.length > SEND_EMAIL_MAX_ATTACHMENTS) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `A message takes at most ${SEND_EMAIL_MAX_ATTACHMENTS} attachments.`);
  }
  const files = [];
  for (const id of new Set(ids as string[])) {
    const file = await context.filesAdmin.get(id);
    await assertFileReadAllowed(context, dataPrincipal, file);
    files.push(file);
  }
  const total = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);
  if (total > SEND_EMAIL_MAX_ATTACHMENT_BYTES) {
    throw new TotalBaseError("FILE_TOO_LARGE", `The attachments add up to ${total} bytes; a message takes at most ${SEND_EMAIL_MAX_ATTACHMENT_BYTES}.`);
  }
  const attachments: EmailAttachment[] = [];
  for (const file of files) {
    const { content } = await context.filesAdmin.readContent(file.id);
    const filename = file.extension && !file.name.toLowerCase().endsWith(`.${file.extension.toLowerCase()}`) ? `${file.name}.${file.extension}` : file.name;
    attachments.push({ filename, content, contentType: file.mime_type });
  }
  return attachments;
}

/** Sending mail is a role capability (Security.md §5.2): SEND_EMAIL granted, or an administrator. */
async function assertSendAllowed(context: WorkflowEngineContext, dataPrincipal: DataPrincipal): Promise<void> {
  if (await context.effectivePermissions.isAdministrators(dataPrincipal.roleIds)) return;
  if ((await context.capabilityPermissions.resolve(dataPrincipal.roleIds, "SEND_EMAIL")) !== "ALLOW") {
    throw new TotalBaseError("EMAIL_SEND_DENIED", "This workflow's executor may not send email - its roles need the Send email capability.");
  }
}

/**
 * An address field: one address or several - a string ("a@x.com, b@y.com")
 * or a list (["a@x.com", "b@y.com"], what a template like {{read.data}}
 * mapped to emails resolves to) - as the sender takes it, comma-joined.
 * Empty, undefined; a list holding anything but text is a design error.
 */
export function address(value: unknown): string | undefined {
  const items = recipients(value);
  return items.length > 0 ? items.join(", ") : undefined;
}

/** At most this many recipients - to, cc and bcc together - per Send email step: one invocation is never a mailing list. */
export const MAX_RECIPIENTS_PER_STEP = 50;

/** One address as a step may name it: `ana@example.com`, or `Ana <ana@example.com>`. */
const ADDRESS_PATTERN = /^(?:[^<>@,;"]*<)?[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+>?$/;

/**
 * An address field's recipients, each checked (Workflows.md §5.16): a value a trigger carried - a webhook's body -
 * is one address or several separated by commas, each a real one, never a text that slips extra recipients or
 * anything else into the message's headers.
 */
function recipients(value: unknown): string[] {
  let items: string[];
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string")) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "A list of recipients holds email addresses only.");
    items = value as string[];
  } else if (typeof value === "string") {
    items = value.split(",");
  } else {
    return [];
  }
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  const invalid = cleaned.find((item) => !ADDRESS_PATTERN.test(item));
  if (invalid !== undefined) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Not an email address: ${JSON.stringify(invalid.slice(0, 100))}.`);
  return cleaned;
}

/** Refuses a step whose recipients, all together, are more than MAX_RECIPIENTS_PER_STEP. */
function assertRecipientCount(...fields: (string | undefined)[]): void {
  const count = fields.reduce((sum, field) => sum + (field ? field.split(",").length : 0), 0);
  if (count > MAX_RECIPIENTS_PER_STEP) {
    throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This step has ${count} recipients - at most ${MAX_RECIPIENTS_PER_STEP} (to, cc and bcc together).`);
  }
}

/**
 * Sends through the instance's mail sender (Workflows.md §5.16).
 * The whole configuration is already template-resolved by the engine. Either
 * an inline message (`subject`, `bodyType`, `textBody`/`htmlBody`) or a
 * MAILING `template` rendered with `data` - the executor needs READ on that
 * template row. Recipients always come from the step, never from template data;
 * the template's default cc/bcc/reply-to apply when the step leaves them empty.
 *
 * A TEST run with an email redirect (Workflows.md §11.1) sends to that one
 * address instead - to, cc, bcc and the template's defaults all replaced -
 * and its result says whom the step would have sent to.
 *
 * `retries` (0-5, default 0): how many more times to send after a failure the relay certainly did not take
 * (sendWithRetries) - the result then carries `attempts`.
 */
/** How long each retry waits, in order: 5 s, 15 s, 30 s, 60 s, 120 s - at most MAX_SEND_RETRIES of them. */
export const SEND_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
export const MAX_SEND_RETRIES = SEND_RETRY_DELAYS_MS.length;

/** `retries`: 0 (the default) to MAX_SEND_RETRIES, a whole number. */
function sendRetries(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const retries = Number(value);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_SEND_RETRIES) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `This step's retries must be a whole number from 0 to ${MAX_SEND_RETRIES}.`);
  }
  return retries;
}

/** Waits `ms`, or until the run is cancelled (false). */
function waitOrCancelled(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sends, and - only with `retries` - again after a failure the relay certainly did not take
 * (EmailSendError.notAccepted: a 4xx answer, or no connection at all), so a retry can never be a second copy.
 * An uncertain outcome, a permanent refusal, SMTP not configured: the first error stands. A cancelled run stops
 * waiting. Returns the attempts made.
 */
export async function sendWithRetries(send: () => Promise<void>, retries: number, signal: AbortSignal | undefined, delaysMs: readonly number[] = SEND_RETRY_DELAYS_MS): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      return attempt;
    } catch (error) {
      const retryable = error instanceof EmailSendError && error.notAccepted;
      if (!retryable || attempt > retries || !(await waitOrCancelled(delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1] ?? 0, signal))) {
        if (attempt > 1 && error instanceof TotalBaseError) {
          throw new TotalBaseError(error.code, `${error.message} (after ${attempt} attempts)`, { cause: error });
        }
        throw error;
      }
    }
  }
}

const sendEmail: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  await assertSendAllowed(context, dataPrincipal);
  let to = address(configuration.to);
  if (!to) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's recipient must resolve to an address or a non-empty list of them.");
  let cc = address(configuration.cc);
  let bcc = address(configuration.bcc);
  const retries = sendRetries(configuration.retries);
  let replyTo = address(configuration.replyTo);
  let subject: string | undefined;
  let body: string | undefined;
  let html: string | undefined;

  const templateId = configuration.template;
  if (templateId !== undefined && templateId !== null && templateId !== "") {
    if (typeof templateId !== "string" || !UUID_PATTERN.test(templateId)) throw new TotalBaseError("TEMPLATE_NOT_FOUND", `Template not found: ${String(templateId)}`);
    await assertTemplateReadAllowed(context, dataPrincipal, templateId);
    const template = await context.templatesAdmin.get(templateId);
    if (template.kind !== "MAILING") throw new TotalBaseError("TEMPLATE_WRONG_KIND", `Template "${template.name}" is not a MAILING template.`);
    const rendered = renderMailingTemplate(template.content, configuration.data ?? {});
    subject = rendered.subject;
    html = rendered.html;
    cc ??= template.defaultCc?.length ? template.defaultCc.join(", ") : undefined;
    bcc ??= template.defaultBcc?.length ? template.defaultBcc.join(", ") : undefined;
    replyTo ??= address(template.defaultReplyTo);
  } else {
    const bodyType = (configuration.bodyType as "text" | "html" | "both" | undefined) ?? "text";
    subject = (configuration.subject as string | undefined)?.trim();
    body = bodyType === "text" || bodyType === "both" ? (configuration.textBody as string | undefined) : undefined;
    html = bodyType === "html" || bodyType === "both" ? (configuration.htmlBody as string | undefined) : undefined;
  }
  if (!subject) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no subject configured.");
  assertRecipientCount(to, cc, bcc);
  const attachments = await readAttachments(context, dataPrincipal, configuration.attachments);

  const redirect = workflowContext.emailRedirect;
  const redirectedFrom = redirect ? { to, ...(cc !== undefined && { cc }), ...(bcc !== undefined && { bcc }) } : undefined;
  if (redirect) {
    to = redirect;
    cc = undefined;
    bcc = undefined;
  }

  const message = {
    to,
    subject,
    ...(cc !== undefined && { cc }),
    ...(bcc !== undefined && { bcc }),
    ...(replyTo !== undefined && { replyTo }),
    ...(body !== undefined && { body }),
    ...(html !== undefined && { html }),
    ...(attachments.length > 0 && { attachments }),
  };
  const attempts = await sendWithRetries(() => context.emailSender.send(message), retries, workflowContext.signal);

  // Names only - a file's content never goes into the run's history (§9.2).
  return { output: "next", result: { to, subject, ...(attachments.length > 0 && { attachments: attachments.map((a) => a.filename) }), ...(redirectedFrom && { redirectedFrom }), ...(attempts > 1 && { attempts }) } };
};

export const EMAIL_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.send-email": sendEmail,
};
