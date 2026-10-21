import type { FastifyInstance, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { SETTINGS_DEFAULTS, SETTINGS_GROUP_METADATA, SETTINGS_METADATA, settingBounds, type SettingKey } from "@totalbase/settings";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { ADMIN_SCHEMAS, NO_CONTENT, adminDoc, object, ok, ref } from "../openapi-admin-docs.js";

/**
 * Settings management (Administration.md §1: "Settings").
 *
 * getGroup/setGroup are generic over whatever's declared in
 * @totalbase/settings' registry.ts - every group there (the full list is
 * Administration.md §7.4) is read by some code path.
 */
const GROUP_PARAM = { description: "Registry group, e.g. `api`, `auth`, `smtp` - 404 for a group with no keys." };

/** A path's group must be one the registry declares keys for. */
function assertKnownGroup(group: string): void {
  if (!Object.keys(SETTINGS_DEFAULTS).some((key) => key.startsWith(`${group}.`))) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Unknown settings group: ${group}`);
  }
}

/**
 * Settings a personal access token may not change, only a signed-in
 * administrator: the ones that decide what a token itself may do - an
 * agent must not grant itself raw SQL, nor widen its own MCP policy.
 */
const SESSION_ONLY_SETTINGS = new Set<string>(["sql_console.token_access"]);
/** Whole groups a token may not change: Settings > MCP decides what an agent - a token - may do. */
const SESSION_ONLY_GROUPS = ["mcp."];

function assertSessionOnlySettings(request: FastifyRequest, keys: string[]): void {
  if (!request.adminToken) return;
  const locked = keys.find((key) => SESSION_ONLY_SETTINGS.has(key) || SESSION_ONLY_GROUPS.some((prefix) => key.startsWith(prefix)));
  if (locked) {
    throw new TotalBaseError("PERMISSION_DENIED", `${locked} is changed by a signed-in administrator only, never through an API token.`);
  }
}

export function registerAdminSettingsRoutes(app: FastifyInstance, context: AppContext, startup: { trustProxy?: boolean } = {}): void {
  const preHandler = requireAdmin(context);

  // Settings applied only at startup: the value in use right now, which
  // the admin compares with the stored one to say a restart is pending.
  const liveValues: Partial<Record<SettingKey, () => unknown>> = {
    "pool.max": () => context.database.poolSettings().poolMax,
    "pool.idle_timeout_ms": () => context.database.poolSettings().poolIdleTimeoutMs,
    "pool.connection_timeout_ms": () => context.database.poolSettings().poolConnectionTimeoutMs,
    "pool.max_lifetime_ms": () => context.database.poolSettings().poolMaxLifetimeMs,
    ...(startup.trustProxy !== undefined ? { "security.trust_proxy": () => startup.trustProxy } : {}),
  };

  app.get("/admin/api/settings", {
    preHandler,
    ...adminDoc("settings", {
      summary: "Every setting's current value",
      response: ok(ref("SettingsValues")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => ({ data: await context.settings.getAll() }));

  // Every key's copy at once, for the admin's Settings search - no values,
  // just what a match is made on and where the key lives (its group and
  // section).
  app.get("/admin/api/settings/schema", {
    preHandler,
    ...adminDoc("settings", {
      summary: "Every setting's copy, for search",
      description: "Label, description, group and section of every key - no values.",
      response: ok(ref("SettingsIndex")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => ({
    data: {
      groups: SETTINGS_GROUP_METADATA,
      fields: (Object.keys(SETTINGS_DEFAULTS) as SettingKey[]).map((key) => {
        const group = key.slice(0, key.indexOf("."));
        const meta = SETTINGS_METADATA[key];
        return { key, group, label: meta?.label ?? key.slice(group.length + 1), description: meta?.description ?? "", section: meta?.section };
      }),
    },
  }));

  app.get<{ Params: { group: string } }>(
    "/admin/api/settings/:group",
    {
      preHandler,
      ...adminDoc("settings", {
        summary: "A settings group's current values",
        pathParameters: { group: GROUP_PARAM },
        response: ok(ref("SettingsValues")),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      assertKnownGroup(request.params.group);
      return { data: await context.settings.getGroup(request.params.group) };
    },
  );

  // Human-facing copy for the Settings UI (Tailscale-style: a subtitle +
  // "what this does" description per setting, the Admin API spec doesn't cover
  // this - see @totalbase/settings/metadata.ts). Static data, no
  // database involved, so this reads straight from the registry/metadata
  // modules rather than through context.settings. A key with no entry in
  // SETTINGS_METADATA still comes back (falls back to its own bare name
  // as the label, empty description) - the admin renders that instead of
  // failing, so this endpoint never 404s just because a group's copy
  // hasn't been written yet.
  app.get<{ Params: { group: string } }>("/admin/api/settings/:group/schema", {
    preHandler,
    ...adminDoc("settings", {
      summary: "A settings group's fields",
      description: "Copy, widget, section, default and numeric bounds of each key in the group.",
      pathParameters: { group: GROUP_PARAM },
      response: ok(ref("SettingsGroupSchema")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request) => {
    const group = request.params.group;
    assertKnownGroup(group);
    const keys = (Object.keys(SETTINGS_DEFAULTS) as SettingKey[]).filter(k => k.startsWith(`${group}.`));
    return {
      data: {
        group: SETTINGS_GROUP_METADATA[group] ?? { label: group, description: "" },
        // `default` lets the admin mark a changed value and offer to
        // restore it; `min`/`max` are the same bounds SettingsService
        // enforces on write.
        fields: keys.map(key => ({
          key,
          ...(SETTINGS_METADATA[key] ?? { label: key.slice(group.length + 1), description: "" }),
          default: SETTINGS_DEFAULTS[key],
          ...(typeof SETTINGS_DEFAULTS[key] === "number" ? settingBounds(key) : {}),
          ...(key in liveValues ? { liveValue: liveValues[key as keyof typeof liveValues]!() } : {}),
        })),
      },
    };
  });

  app.patch<{ Params: { group: string }; Body: { data?: unknown } | undefined }>(
    "/admin/api/settings/:group",
    {
      preHandler,
      ...adminDoc("settings", {
        summary: "Change settings in a group",
        description:
          "Keys bare (`max_limit`) or fully dotted (`api.max_limit`). All or nothing: every value is checked against its " +
          "type and bounds before anything is written (INVALID_SETTING). A value equal to the registry default drops the override.",
        pathParameters: { group: GROUP_PARAM },
        requestBody: { schema: dataEnvelope({ type: "object", additionalProperties: true }) },
        response: ok(ref("SettingsValues")),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      assertKnownGroup(request.params.group);
      const patch = request.body?.data;
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new TotalBaseError("INVALID_SETTING", "Expected { data: { <key>: <value>, ... } }.");
      }
      const group = request.params.group;
      assertSessionOnlySettings(request, Object.keys(patch).map((key) => (key.startsWith(`${group}.`) ? key : `${group}.${key}`)));
      await context.settings.setGroup(request.params.group, patch as Record<string, unknown>);
      return { data: await context.settings.getGroup(request.params.group) };
    },
  );

  // Drops a stored override - the key reads its registry default again.
  app.delete<{ Params: { group: string; key: string } }>(
    "/admin/api/settings/:group/:key",
    {
      preHandler,
      ...adminDoc("settings", {
        summary: "Restore a setting's default",
        description: "Drops the stored override - the key reads its registry default again. 404 for an unknown group or key.",
        pathParameters: { group: GROUP_PARAM, key: { description: "Bare (`max_limit`) or fully dotted (`api.max_limit`)." } },
        response: ok(ref("SettingsValues")),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const { group, key } = request.params;
      assertKnownGroup(group);
      const fullKey = key.startsWith(`${group}.`) ? key : `${group}.${key}`;
      if (!(fullKey in SETTINGS_DEFAULTS)) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", `Unknown setting key for group "${group}": ${key}`);
      }
      assertSessionOnlySettings(request, [fullKey]);
      await context.settings.reset(fullKey as SettingKey);
      return { data: await context.settings.getGroup(group) };
    },
  );

  // Sends one message through the current smtp.* settings - the admin's
  // "Send test email". A delivery failure comes back as-is
  // (SMTP_NOT_CONFIGURED / EMAIL_SEND_FAILED with the server's reason).
  app.post<{ Body: { data?: { to?: unknown } } | undefined }>("/admin/api/settings/mail/test", {
    preHandler,
    ...adminDoc("settings", {
      summary: "Send a test email",
      description:
        "Delivers one message through the saved smtp.* settings. SMTP_NOT_CONFIGURED (409) when host/from are empty; " +
        "EMAIL_SEND_FAILED (502) with the relay's own reason when it refuses the message.",
      requestBody: { schema: dataEnvelope(object({ to: { type: "string", format: "email" } }, ["to"])) },
      response: ok(object({ sent: { type: "boolean" } })),
    }),
  }, async (request) => {
    const raw = request.body?.data?.to;
    const to = typeof raw === "string" ? raw.trim() : "";
    if (!to.includes("@")) throw new TotalBaseError("INVALID_QUERY", "Expected `to`: the email address to send the test to.");
    await context.emailSender.send({
      to,
      subject: "TotalBase test email",
      body: "This is a test email sent from the TotalBase Admin API.",
    });
    return { data: { sent: true } };
  });

  // Writes, reads back and deletes one probe object in the bucket of the
  // saved s3.* settings - the admin's "Test connection" on S3 storage.
  app.post("/admin/api/settings/s3/verify", {
    preHandler,
    ...adminDoc("settings", {
      summary: "Test the S3 storage connection",
      description:
        "Writes a small probe object under the saved s3.* settings' bucket and prefix (verify/), reads it back and deletes it - " +
        "also while s3.enabled is off, to check before turning it on. 204 when all of it works; INVALID_SETTING when the " +
        "endpoint, bucket or credentials are missing; FILE_STORAGE_ERROR (502) with the service's own reason (an unreachable " +
        "endpoint, a missing bucket, refused credentials).",
      response: NO_CONTENT,
    }),
  }, async (_request, reply) => {
    await context.s3.verify();
    return reply.code(204).send();
  });

  // Connects and authenticates through the current smtp.* settings without
  // sending anything - the admin's "Test connection". Nothing about the
  // credentials comes back, only whether the relay accepted them.
  app.post("/admin/api/settings/mail/verify", {
    preHandler,
    ...adminDoc("settings", {
      summary: "Test the SMTP connection",
      description:
        "Connects to the relay of the saved smtp.* settings and authenticates (when a username is set), sending no message. " +
        "204 when the relay accepts; SMTP_NOT_CONFIGURED (409) when host/from are empty; SMTP_CONNECTION_FAILED (502) with " +
        "the relay's own reason when it can't be reached or refuses the credentials.",
      response: NO_CONTENT,
    }),
  }, async (_request, reply) => {
    await context.emailSender.verify();
    return reply.code(204).send();
  });
}
