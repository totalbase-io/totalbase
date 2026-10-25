import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import {
  MAIL_TEMPLATE_DEFAULTS,
  SYSTEM_EMAIL_DEFINITIONS,
  SYSTEM_EMAIL_SLOTS,
  validateMailTemplate,
  type MailTemplate,
  type SettingKey,
  type SystemEmailSlot,
} from "@totalbase/settings";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, ok, ref } from "../openapi-admin-docs.js";
import { SYSTEM_EMAIL_SLOT, SYSTEM_EMAILS_SCHEMAS } from "../openapi-admin-docs-users.js";

const SLOT_PARAM = { slot: { description: "Which system email (404 for any other).", schema: SYSTEM_EMAIL_SLOT } };
const TEMPLATE_RULES =
  "Placeholders are `{{variable}}` from the slot's `variables` only; a slot with `hasAction` must include `{{action_url}}` " +
  "in every non-empty body. 400 INVALID_SETTING otherwise.";

/**
 * System emails (Administration.md §8.2): the fixed set of messages TotalBase
 * sends - each one a `mail.templates.<slot>` setting whose default lives
 * in code. Editing stores a settings override; DELETE drops it so the
 * slot reads its default again. The admin edits these in Templates →
 * System.
 */

/** A preview's values for the variables a slot has beyond the common ones. */
const PREVIEW_VARIABLES: Partial<Record<SystemEmailSlot, Record<string, string>>> = {
  email_changed: { new_email: "new-address@example.com" },
  token_created: { "token.name": "deploy-bot", "token.plane": "API" },
};

/** Slots that can be switched off, and the setting that does it. */
const ENABLED_SETTINGS: Partial<Record<SystemEmailSlot, SettingKey>> = {
  password_changed: "auth.password_changed_email_enabled",
  email_changed: "auth.email_changed_email_enabled",
  mfa_disabled: "auth.mfa_disabled_email_enabled",
  token_created: "auth.token_created_email_enabled",
  user_welcome: "auth.welcome_email_enabled",
};

function parseSlot(value: string): SystemEmailSlot {
  if (!(SYSTEM_EMAIL_SLOTS as readonly string[]).includes(value)) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Unknown system email: ${value}`);
  }
  return value as SystemEmailSlot;
}

function parseTemplate(slot: SystemEmailSlot, body: unknown): MailTemplate {
  const problem = validateMailTemplate(slot, body);
  if (problem) throw new TotalBaseError("INVALID_SETTING", problem);
  const { subject, html, text } = body as MailTemplate;
  return { subject, html, text };
}

export function registerAdminSystemEmailsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  const settingKey = (slot: SystemEmailSlot) => `mail.templates.${slot}` as const;

  async function describe(slot: SystemEmailSlot) {
    const enabledKey = ENABLED_SETTINGS[slot];
    return {
      slot,
      ...SYSTEM_EMAIL_DEFINITIONS[slot],
      overridden: await context.settings.isOverridden(settingKey(slot)),
      /** null = always sent when its flow runs; otherwise the current on/off setting. */
      enabled: enabledKey ? Boolean(await context.settings.get(enabledKey)) : null,
      enabledSetting: enabledKey ?? null,
    };
  }

  app.get("/admin/api/system-emails", {
    preHandler,
    ...adminDoc("system-emails", {
      summary: "List system emails",
      description: "The fixed set of emails TotalBase sends (invitation, password reset, verification, security notices) - each a `mail.templates.<slot>` setting.",
      response: ok(arrayOf(ref("SystemEmailsItem"))),
      schemas: SYSTEM_EMAILS_SCHEMAS,
    }),
  }, async () => ({
    data: await Promise.all(SYSTEM_EMAIL_SLOTS.map(describe)),
  }));

  app.get<{ Params: { slot: string } }>("/admin/api/system-emails/:slot", {
    preHandler,
    ...adminDoc("system-emails", {
      summary: "Get a system email",
      description: "`template` is what is sent now (the stored override, or the default); `defaultTemplate` the built-in one.",
      pathParameters: SLOT_PARAM,
      response: ok(ref("SystemEmailsDetail")),
      schemas: SYSTEM_EMAILS_SCHEMAS,
    }),
  }, async (request) => {
    const slot = parseSlot(request.params.slot);
    return {
      data: {
        ...(await describe(slot)),
        template: await context.settings.get(settingKey(slot)),
        defaultTemplate: MAIL_TEMPLATE_DEFAULTS[slot],
      },
    };
  });

  app.put<{ Params: { slot: string }; Body: { data?: unknown } | undefined }>("/admin/api/system-emails/:slot", {
    preHandler,
    ...adminDoc("system-emails", {
      summary: "Edit a system email",
      description: "Stores the template as a settings override. " + TEMPLATE_RULES,
      pathParameters: SLOT_PARAM,
      requestBody: { schema: dataEnvelope(ref("SystemEmailsTemplate")) },
      response: ok(ref("SystemEmailsDetail")),
      schemas: SYSTEM_EMAILS_SCHEMAS,
    }),
  }, async (request) => {
    const slot = parseSlot(request.params.slot);
    const template = parseTemplate(slot, request.body?.data);
    await context.settings.set(settingKey(slot), template);
    return { data: { ...(await describe(slot)), template, defaultTemplate: MAIL_TEMPLATE_DEFAULTS[slot] } };
  });

  app.delete<{ Params: { slot: string } }>("/admin/api/system-emails/:slot", {
    preHandler,
    ...adminDoc("system-emails", {
      summary: "Restore a system email's default",
      description: "Drops the stored override; answers 200 with the email as it now reads.",
      pathParameters: SLOT_PARAM,
      response: ok(ref("SystemEmailsDetail")),
      schemas: SYSTEM_EMAILS_SCHEMAS,
    }),
  }, async (request) => {
    const slot = parseSlot(request.params.slot);
    await context.settings.reset(settingKey(slot));
    return {
      data: { ...(await describe(slot)), template: MAIL_TEMPLATE_DEFAULTS[slot], defaultTemplate: MAIL_TEMPLATE_DEFAULTS[slot] },
    };
  });

  // Renders a (possibly unsaved) template for the signed-in admin, with a
  // sample link built from the real `auth.links.*` setting - what the
  // email would look like, without sending anything or issuing a token.
  app.post<{ Params: { slot: string }; Body: { data?: unknown } | undefined }>(
    "/admin/api/system-emails/:slot/preview",
    {
      preHandler,
      ...adminDoc("system-emails", {
        summary: "Preview a system email",
        description:
          "Renders a (possibly unsaved) template for the signed-in admin, with a sample link built from the real " +
          "auth.links.* setting. Sends nothing and issues no token. " + TEMPLATE_RULES,
        pathParameters: SLOT_PARAM,
        requestBody: { schema: dataEnvelope(ref("SystemEmailsTemplate")) },
        response: ok(ref("SystemEmailsRendered")),
        schemas: SYSTEM_EMAILS_SCHEMAS,
      }),
    },
    async (request) => {
      const slot = parseSlot(request.params.slot);
      const template = parseTemplate(slot, request.body?.data);
      const admin = request.admin!;
      const flow = { user_invitation: "invitation", password_reset: "password_reset", email_verification: "email_verification" } as const;
      const action = slot in flow
        ? {
            url: await context.auth.mailer.buildLink(flow[slot as keyof typeof flow], "sample-token"),
            expiresInHours: await context.settings.get(
              slot === "user_invitation" ? "auth.invitation_ttl_hours" : slot === "password_reset" ? "auth.password_reset_ttl_minutes" : "auth.email_verification_ttl_hours",
            ) / (slot === "password_reset" ? 60 : 1),
          }
        : undefined;
      const rendered = await context.auth.mailer.render(
        slot,
        { email: admin.email ?? "you@example.com", name: admin.name },
        action,
        template,
        PREVIEW_VARIABLES[slot],
      );
      return { data: rendered };
    },
  );
}
