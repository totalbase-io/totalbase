import type { MailTemplate, SettingsService, SystemEmailSlot } from "@totalbase/settings";
import { TEMPLATE_PLACEHOLDER } from "@totalbase/settings";
import type { EmailSender } from "./email-sender.js";

/** The flows whose emails carry a single-use link - one `auth.links.*` setting each. */
export type SystemLinkFlow = "invitation" | "password_reset" | "email_verification";

export interface SystemEmailRecipient {
  email: string;
  name: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

/**
 * Fills `{{name}}` placeholders (the system emails' grammar, TEMPLATE_PLACEHOLDER)
 * from `variables`, HTML-escaping each value when `escape` is set. A
 * placeholder with no value renders empty. The one renderer for every email
 * TotalBase sends: system emails and MAILING templates
 * (Specification_Workflows.md §5.16).
 */
export function fillMailPlaceholders(content: string, variables: Record<string, string>, escape: boolean): string {
  return content.replace(TEMPLATE_PLACEHOLDER, (_, name: string) => {
    const value = variables[name] ?? "";
    return escape ? escapeHtml(value) : value;
  });
}

/**
 * The fixed frame every system email's HTML body is sent in: font, width
 * and an instance footer. Applied here, at render time, rather than stored
 * in the template - an edited template is plain semantic HTML (what the
 * admin's rich-text editor keeps), so the frame can't be lost by editing.
 * Inline styles only: many mail clients ignore <style> blocks.
 */
function wrapMailHtml(body: string, footer: string): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:520px">`,
    body,
    `<p style="margin-top:32px;color:#6b7280;font-size:12px">${footer}</p>`,
    `</div>`,
  ].join("\n");
}

/**
 * Fills `{{name}}` placeholders from `variables`. Values are escaped in the
 * HTML body only - the subject and plain-text body are not HTML. A
 * placeholder with no value renders empty (templates are validated
 * against each slot's variable list when saved, so this is only a
 * safety net). A non-empty HTML body is wrapped in the fixed layout.
 */
export function renderMailTemplate(template: MailTemplate, variables: Record<string, string>): RenderedEmail {
  const fill = (content: string, escape: boolean) => fillMailPlaceholders(content, variables, escape);
  const html = fill(template.html, true);
  const footer = [variables["instance.name"], variables["instance.public_url"]]
    .filter((part): part is string => !!part?.trim())
    .map(escapeHtml)
    .join(" · ");
  return {
    subject: fill(template.subject, false),
    html: html.trim() ? wrapMailHtml(html, footer) : "",
    text: fill(template.text, false),
  };
}

/** "15 minutes", "24 hours", "7 days" - how long a link stays valid, for `{{expires_in}}`. */
export function formatDuration(hours: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (hours < 1) return plural(Math.max(1, Math.round(hours * 60)), "minute");
  if (hours < 48 || hours % 24 !== 0) return plural(Math.round(hours), "hour");
  return plural(hours / 24, "day");
}

/**
 * Renders and sends TotalBase's system emails (Specification_Administration.md §8): the
 * template comes from the `mail.templates.<slot>` setting (registry
 * default unless an admin edited it), and the link from the matching
 * `auth.links.*` setting, built on `system.public_url` - never on a
 * request's Host header (Specification_Administration.md §7.6).
 */
export class SystemMailer {
  constructor(
    private readonly settings: SettingsService,
    private readonly emailSender: EmailSender,
    /** TOTALBASE_PUBLIC_URL - used while `system.public_url` is empty. */
    private readonly fallbackPublicUrl: string,
  ) {}

  /** The canonical external URL, without a trailing slash. */
  async publicUrl(): Promise<string> {
    const configured = (await this.settings.get("system.public_url")).trim();
    return (configured || this.fallbackPublicUrl).replace(/\/+$/, "");
  }

  async buildLink(flow: SystemLinkFlow, token: string): Promise<string> {
    const [template, publicUrl] = await Promise.all([
      this.settings.get(`auth.links.${flow}`),
      this.publicUrl(),
    ]);
    return template.replace(TEMPLATE_PLACEHOLDER, (_, name: string) => {
      if (name === "public_url") return publicUrl;
      if (name === "token") return encodeURIComponent(token);
      return "";
    });
  }

  async render(
    slot: SystemEmailSlot,
    recipient: SystemEmailRecipient,
    action?: { url: string; expiresInHours: number },
    template?: MailTemplate,
    /** Slot-specific variables beyond the common ones (e.g. email_changed's `new_email`). */
    extra?: Record<string, string>,
  ): Promise<RenderedEmail> {
    const [stored, instanceName, publicUrl] = await Promise.all([
      template ? Promise.resolve(template) : this.settings.get(`mail.templates.${slot}`),
      this.settings.get("system.instance_name"),
      this.publicUrl(),
    ]);
    return renderMailTemplate(stored, {
      "user.name": recipient.name?.trim() || recipient.email,
      "user.email": recipient.email,
      "instance.name": instanceName,
      "instance.public_url": publicUrl,
      ...(action && { action_url: action.url, expires_in: formatDuration(action.expiresInHours) }),
      ...extra,
    });
  }

  async send(
    slot: SystemEmailSlot,
    recipient: SystemEmailRecipient,
    action?: { url: string; expiresInHours: number },
    extra?: Record<string, string>,
  ): Promise<void> {
    const email = await this.render(slot, recipient, action, undefined, extra);
    await this.emailSender.send({
      to: recipient.email,
      subject: email.subject,
      ...(email.text.trim() && { body: email.text }),
      ...(email.html.trim() && { html: email.html }),
    });
  }
}
