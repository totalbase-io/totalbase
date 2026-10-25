/**
 * System emails (Administration.md §8.2, §8.3): the fixed set of
 * messages TotalBase itself sends - invitation, password reset, email
 * verification, and three notices. Each is a typed setting
 * (`mail.templates.<slot>`) whose default lives here in code; an admin's
 * edit is stored as a normal settings override, so adding a slot never
 * needs a schema migration.
 *
 * The HTML body is content only - semantic HTML (paragraphs, bold, links),
 * the shape the admin's rich-text editor produces and keeps. The sender
 * wraps it in a fixed layout (font, width, instance footer) when rendering,
 * see `renderMailTemplate` in @totalbase/auth - so the layout never lives in,
 * or gets lost from, an edited template.
 *
 * Templates are plain text with `{{variable}}` placeholders from a fixed,
 * per-slot list - no expressions, loops, or filters (Administration.md §8.3:
 * "arbitrary code execution inside templates is prohibited"). Unknown
 * placeholders are rejected when saving, so a typo can't silently render
 * as an empty string in a real email.
 */

export interface MailTemplate {
  subject: string;
  html: string;
  text: string;
}

export const SYSTEM_EMAIL_SLOTS = [
  "user_invitation",
  "password_reset",
  "email_verification",
  "password_changed",
  "email_changed",
  "mfa_disabled",
  "token_created",
  "user_welcome",
] as const;

export type SystemEmailSlot = (typeof SYSTEM_EMAIL_SLOTS)[number];

const COMMON_VARIABLES = ["user.name", "user.email", "instance.name", "instance.public_url"] as const;
const ACTION_VARIABLES = ["action_url", "expires_in"] as const;

export interface SystemEmailDefinition {
  label: string;
  description: string;
  /** Carries a single-use link (`{{action_url}}`), which the template must include. */
  hasAction: boolean;
  variables: readonly string[];
}

export const SYSTEM_EMAIL_DEFINITIONS: Record<SystemEmailSlot, SystemEmailDefinition> = {
  user_invitation: {
    label: "Invitation",
    description: "Sent when an admin invites someone - the link lets them set their password.",
    hasAction: true,
    variables: [...COMMON_VARIABLES, ...ACTION_VARIABLES],
  },
  password_reset: {
    label: "Password reset",
    description: "Sent when someone asks to reset a forgotten password, or an admin sends a reset.",
    hasAction: true,
    variables: [...COMMON_VARIABLES, ...ACTION_VARIABLES],
  },
  email_verification: {
    label: "Email verification",
    description: "Sent after registration so the person confirms they own the address.",
    hasAction: true,
    variables: [...COMMON_VARIABLES, ...ACTION_VARIABLES],
  },
  password_changed: {
    label: "Password changed",
    description: "A security notice sent after a password is changed or reset.",
    hasAction: false,
    variables: [...COMMON_VARIABLES],
  },
  email_changed: {
    label: "Email changed",
    description: "A security notice sent to the previous address when an admin changes a user's email.",
    hasAction: false,
    // user.email is the recipient - the previous address; new_email is the one it changed to.
    variables: [...COMMON_VARIABLES, "new_email"],
  },
  mfa_disabled: {
    label: "Two-factor authentication turned off",
    description: "A security notice sent when an account's two-factor authentication is turned off, or reset by an admin.",
    hasAction: false,
    variables: [...COMMON_VARIABLES],
  },
  token_created: {
    label: "New API token",
    description: "A security notice sent when an API token is created or regenerated for an account - a new key that can act as the person.",
    hasAction: false,
    variables: [...COMMON_VARIABLES, "token.name", "token.plane"],
  },
  user_welcome: {
    label: "Welcome",
    description: "Sent once an invited or registered account is ready to use (off by default).",
    hasAction: false,
    variables: [...COMMON_VARIABLES],
  },
};

/** The link a person follows, plus the raw URL for mail apps that strip links. */
function action(label: string): string {
  return `<p><a href="{{action_url}}">${label}</a></p>
<p>Or copy this link into your browser:<br>{{action_url}}</p>`;
}

export const MAIL_TEMPLATE_DEFAULTS: Record<SystemEmailSlot, MailTemplate> = {
  user_invitation: {
    subject: "You've been invited to {{instance.name}}",
    html: `<p>Hi {{user.name}},</p>
<p>You've been invited to join <strong>{{instance.name}}</strong>. Set your password to get started.</p>
${action("Accept invitation")}
<p>This link expires in {{expires_in}}.</p>`,
    text: `Hi {{user.name}},

You've been invited to join {{instance.name}}. Set your password to get started:

{{action_url}}

This link expires in {{expires_in}}.`,
  },
  password_reset: {
    subject: "Reset your {{instance.name}} password",
    html: `<p>Hi {{user.name}},</p>
<p>We received a request to reset your password. If it was you, choose a new one below.</p>
${action("Reset password")}
<p>This link expires in {{expires_in}}. If you didn't ask for this, you can ignore this email - your password stays the same.</p>`,
    text: `Hi {{user.name}},

We received a request to reset your password. If it was you, choose a new one here:

{{action_url}}

This link expires in {{expires_in}}. If you didn't ask for this, you can ignore this email - your password stays the same.`,
  },
  email_verification: {
    subject: "Confirm your email for {{instance.name}}",
    html: `<p>Hi {{user.name}},</p>
<p>Please confirm that <strong>{{user.email}}</strong> is your email address.</p>
${action("Confirm email")}
<p>This link expires in {{expires_in}}.</p>`,
    text: `Hi {{user.name}},

Please confirm that {{user.email}} is your email address:

{{action_url}}

This link expires in {{expires_in}}.`,
  },
  password_changed: {
    subject: "Your {{instance.name}} password was changed",
    html: `<p>Hi {{user.name}},</p>
<p>The password for <strong>{{user.email}}</strong> was just changed.</p>
<p>If this wasn't you, reset your password right away and contact your administrator.</p>`,
    text: `Hi {{user.name}},

The password for {{user.email}} was just changed.

If this wasn't you, reset your password right away and contact your administrator.`,
  },
  email_changed: {
    subject: "Your {{instance.name}} email was changed",
    html: `<p>Hi {{user.name}},</p>
<p>The email address of your account was changed from <strong>{{user.email}}</strong> to <strong>{{new_email}}</strong>. From now on, sign in and receive account emails with the new address.</p>
<p>If you didn't expect this, contact your administrator right away.</p>`,
    text: `Hi {{user.name}},

The email address of your account was changed from {{user.email}} to {{new_email}}. From now on, sign in and receive account emails with the new address.

If you didn't expect this, contact your administrator right away.`,
  },
  mfa_disabled: {
    subject: "Two-factor authentication was turned off on {{instance.name}}",
    html: `<p>Hi {{user.name}},</p>
<p>Two-factor authentication was just turned off for <strong>{{user.email}}</strong>. Signing in now asks only for your password.</p>
<p>If this wasn't you, change your password right away and contact your administrator.</p>`,
    text: `Hi {{user.name}},

Two-factor authentication was just turned off for {{user.email}}. Signing in now asks only for your password.

If this wasn't you, change your password right away and contact your administrator.`,
  },
  token_created: {
    subject: "A new API token for your {{instance.name}} account",
    html: `<p>Hi {{user.name}},</p>
<p>A new key was just issued for the API token <strong>{{token.name}}</strong> ({{token.plane}}) of <strong>{{user.email}}</strong>. Whoever holds it can act as you.</p>
<p>If you didn't expect this, revoke the token and contact your administrator.</p>`,
    text: `Hi {{user.name}},

A new key was just issued for the API token {{token.name}} ({{token.plane}}) of {{user.email}}. Whoever holds it can act as you.

If you didn't expect this, revoke the token and contact your administrator.`,
  },
  user_welcome: {
    subject: "Welcome to {{instance.name}}",
    html: `<p>Hi {{user.name}},</p>
<p>Your account on <strong>{{instance.name}}</strong> is ready.</p>`,
    text: `Hi {{user.name}},

Your account on {{instance.name}} is ready.`,
  },
};

/** Matches `{{ name }}` placeholders - letters, digits, `_` and `.` only. */
export const TEMPLATE_PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every placeholder name a string uses. */
export function templatePlaceholders(value: string): string[] {
  return [...value.matchAll(TEMPLATE_PLACEHOLDER)].map((match) => match[1]!);
}

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 100_000;

/** Returns a human-readable problem with a system email template, or null when it's valid. */
export function validateMailTemplate(slot: SystemEmailSlot, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Expected an object with subject, html and text.";
  }
  const template = value as Record<string, unknown>;
  for (const field of ["subject", "html", "text"] as const) {
    if (typeof template[field] !== "string") return `"${field}" must be a string.`;
  }
  const { subject, html, text } = template as unknown as MailTemplate;
  if (!subject.trim()) return "The subject can't be empty.";
  if (subject.length > MAX_SUBJECT_LENGTH) return `The subject can't be longer than ${MAX_SUBJECT_LENGTH} characters.`;
  if (/[\r\n]/.test(subject)) return "The subject must be a single line.";
  if (!html.trim() && !text.trim()) return "Provide an HTML body, a plain-text body, or both.";
  if (html.length > MAX_BODY_LENGTH || text.length > MAX_BODY_LENGTH) {
    return `A body can't be longer than ${MAX_BODY_LENGTH} characters.`;
  }

  const definition = SYSTEM_EMAIL_DEFINITIONS[slot];
  const allowed = new Set(definition.variables);
  for (const [field, content] of [["subject", subject], ["html", html], ["text", text]] as const) {
    const unknown = templatePlaceholders(content).find((name) => !allowed.has(name));
    if (unknown) return `Unknown variable {{${unknown}}} in the ${field}. Available: ${definition.variables.map((v) => `{{${v}}}`).join(", ")}.`;
  }
  if (definition.hasAction) {
    for (const [field, content] of [["html", html], ["text", text]] as const) {
      if (content.trim() && !templatePlaceholders(content).includes("action_url")) {
        return `The ${field} body must include {{action_url}} - it's the link the person follows.`;
      }
    }
  }
  return null;
}

/** Variables a system link (`auth.links.*`) may use. */
export const LINK_VARIABLES = ["public_url", "token"] as const;

/** Returns a problem with a system link template, or null when it's valid. */
export function validateLinkTemplate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "Expected a non-empty URL.";
  const unknown = templatePlaceholders(value).find((name) => !(LINK_VARIABLES as readonly string[]).includes(name));
  if (unknown) return `Unknown variable {{${unknown}}}. Available: {{public_url}}, {{token}}.`;
  if (!templatePlaceholders(value).includes("token")) return "The link must include {{token}}.";
  const sample = value.replace(TEMPLATE_PLACEHOLDER, (_, name: string) => (name === "public_url" ? "https://example.com" : "TOKEN"));
  try {
    const url = new URL(sample);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The link must be an http(s) URL.";
  } catch {
    return "The link must be an absolute URL - start it with {{public_url}} or https://.";
  }
  return null;
}

/** Returns a problem with `system.public_url`, or null. Empty means "use TOTALBASE_PUBLIC_URL". */
export function validatePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return "Expected a URL.";
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The public URL must use http or https.";
    if (url.search || url.hash) return "The public URL can't have a query string or fragment.";
  } catch {
    return "Expected an absolute URL, e.g. https://totalbase.example.com.";
  }
  return null;
}
