import type { FastifyInstance, FastifyRequest } from "fastify";
import { signEmbedPreviewToken, validateEmbedDisplay, validateEmbedVariables, type EmbedInput } from "@totalbase/dashboards";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, created, DATE_TIME, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import { optionalData, type DataBody } from "../request-body.js";

/** How long a drawer's preview token lives - the drawer asks for a new one before then. */
export const EMBED_PREVIEW_TTL_SECONDS = 10 * 60;

const EMBED_SCHEMAS = {
  DashboardEmbed: object({
    id: UUID,
    dashboard: UUID,
    name: { type: "string", maxLength: 32 },
    type: { type: "string", enum: ["LINK", "SIGNED"], description: "LINK: a public link, anyone with the URL sees it. SIGNED: a portal's backend signs a token per visit." },
    display: {
      type: "object",
      description: "How it looks: theme (light, dark, auto), titled, transparent, refreshSeconds (null = off; absent = the dashboard's).",
      additionalProperties: true,
    },
    variables: {
      type: "object",
      description: "By variable name: { mode: EDITABLE | HIDDEN | LOCKED, value? }. A LOCKED variable with no value takes it from a SIGNED token; a published variable not listed is EDITABLE.",
      additionalProperties: true,
    },
    origins: { type: "array", items: { type: "string" }, description: "Sites that may frame it, within dashboards.embed_allowed_origins; empty = all of those." },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    revokedAt: { type: ["string", "null"], format: "date-time" },
    lastUsedAt: { type: ["string", "null"], format: "date-time" },
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
    link: { type: ["string", "null"], description: "LINK only: its secret (tbe_…) - the page is /admin/embed/<link>." },
    url: {
      type: "string",
      description: "Its page under system.public_url: a LINK's whole address (what is shared); a SIGNED one's, to which the portal appends #<token> per visit.",
    },
  }),
};

const EMBED_INPUT = object({
  name: { type: "string", maxLength: 32 },
  type: { type: "string", enum: ["LINK", "SIGNED"], description: "Set when it's created; never changes." },
  display: { type: "object", additionalProperties: true },
  variables: { type: "object", additionalProperties: true },
  origins: { type: "array", items: { type: "string" } },
  expiresAt: { type: ["string", "null"], format: "date-time", description: "null = never." },
});

/** Embed writes are recorded like any administrative change (Specification_Dashboards.md §9.5). */
async function audit(context: AppContext, request: FastifyRequest, event: string, embed: { id: string; dashboard: string; name: string }) {
  try {
    await context.audit.record(context.database, {
      requestId: request.id,
      principal: { type: "ADMIN", id: request.admin!.id },
      // An access event (Specification_Security.md §11.6): an embed decides who may see a dashboard's data.
      action: "AUTH",
      status: "EXECUTED",
      source: "admin",
      metadata: { event: `dashboard_embed.${event}`, embed: embed.id, dashboard: embed.dashboard, name: embed.name },
      startedAt: new Date(),
      finishedAt: new Date(),
    });
  } catch {
    // best-effort; never mask the write
  }
}

/**
 * A dashboard's embeds (Specification_Dashboards.md §9.5) - administrators
 * only: create a public link or a signed embed, change how it looks and
 * what it locks, revoke or delete it, preview one being designed, and see
 * which embeds a draft's variables would break before publishing it.
 */
export function registerAdminDashboardEmbedsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  const base = "/admin/api/dashboards/:id/embeds";
  const ID = { id: UUID_PARAM };
  const EMBED_ID = { id: UUID_PARAM, embedId: UUID_PARAM };
  const allowedOrigins = () => context.settings.get("dashboards.embed_allowed_origins");
  const dashboardOf = (id: string) => context.dashboardsAdmin.get(id);
  // An absolute link leaving TotalBase comes from system.public_url (else TOTALBASE_PUBLIC_URL), never the request's Host (AGENTS.md §19A).
  const withUrl = async <E extends { id: string; type: string; link: string | null }>(embed: E) => {
    const publicUrl = await context.auth.mailer.publicUrl();
    return { ...embed, url: `${publicUrl}/admin/embed/${embed.type === "LINK" && embed.link ? embed.link : embed.id}` };
  };

  app.get<{ Params: { id: string } }>(base, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "List a dashboard's embeds",
      description: "Every embed, revoked ones included - a link's secret with it, so it can be copied again.",
      pathParameters: ID,
      response: ok(arrayOf(ref("DashboardEmbed"))),
      schemas: EMBED_SCHEMAS,
    }),
  }, async (request) => {
    await dashboardOf(request.params.id);
    return { data: await Promise.all((await context.dashboardEmbeds.list(request.params.id)).map(withUrl)) };
  });

  app.post<{ Params: { id: string }; Body: DataBody<EmbedInput> }>(base, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Create an embed",
      description:
        "A public LINK (its secret generated here) or a SIGNED embed. A LOCKED variable of a link needs its value; " +
        "origins must be among dashboards.embed_allowed_origins. 409 DASHBOARD_EMBED_NAME_DUPLICATE for a name the dashboard already uses.",
      pathParameters: ID,
      requestBody: { schema: { type: "object", properties: { data: EMBED_INPUT } } },
      response: created(ref("DashboardEmbed")),
      schemas: EMBED_SCHEMAS,
    }),
  }, async (request, reply) => {
    await dashboardOf(request.params.id);
    const embed = await context.dashboardEmbeds.create(request.params.id, optionalData(request.body), request.admin!.id, await allowedOrigins());
    await audit(context, request, "create", embed);
    reply.code(201);
    return { data: await withUrl(embed) };
  });

  app.patch<{ Params: { id: string; embedId: string }; Body: DataBody<EmbedInput> }>(`${base}/:embedId`, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Change an embed",
      description: "Its name, display, variables, origins or expiry - applies at once, the same link and the same tokens. Its type never changes.",
      pathParameters: EMBED_ID,
      requestBody: { schema: { type: "object", properties: { data: EMBED_INPUT } } },
      response: ok(ref("DashboardEmbed")),
      schemas: EMBED_SCHEMAS,
    }),
  }, async (request) => {
    const embed = await context.dashboardEmbeds.update(request.params.id, request.params.embedId, optionalData(request.body), await allowedOrigins());
    await audit(context, request, "update", embed);
    return { data: await withUrl(embed) };
  });

  app.post<{ Params: { id: string; embedId: string } }>(`${base}/:embedId/revoke`, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Revoke an embed",
      description: "Stops it at once and for good: its link, or every token naming it, stops working.",
      pathParameters: EMBED_ID,
      response: ok(ref("DashboardEmbed")),
      schemas: EMBED_SCHEMAS,
    }),
  }, async (request) => {
    const embed = await context.dashboardEmbeds.revoke(request.params.id, request.params.embedId);
    await audit(context, request, "revoke", embed);
    return { data: await withUrl(embed) };
  });

  app.delete<{ Params: { id: string; embedId: string } }>(`${base}/:embedId`, {
    preHandler,
    ...adminDoc("dashboards", { summary: "Delete an embed", pathParameters: EMBED_ID, response: NO_CONTENT }),
  }, async (request, reply) => {
    const embed = await context.dashboardEmbeds.get(request.params.id, request.params.embedId);
    await context.dashboardEmbeds.delete(request.params.id, request.params.embedId);
    await audit(context, request, "delete", embed);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: DataBody<{ display?: unknown; variables?: unknown }> }>(`${base}/preview`, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Preview an embed being designed",
      description:
        "A token for /admin/embed/preview#<token> showing the published dashboard with this display and these variables - " +
        "signed by TotalBase with a key derived from the master key, valid 10 minutes, whether or not embedding is on.",
      pathParameters: ID,
      requestBody: { schema: { type: "object", properties: { data: object({ display: { type: "object", additionalProperties: true }, variables: { type: "object", additionalProperties: true } }) } } },
      response: ok(object({ token: { type: "string" }, expiresAt: DATE_TIME })),
    }),
  }, async (request) => {
    const dashboard = await dashboardOf(request.params.id);
    const body = optionalData(request.body);
    // The same checks as an embed's - a SIGNED one's locked values may be left out (shown as nothing).
    const display = validateEmbedDisplay(body.display);
    const variables = validateEmbedVariables(body.variables, "SIGNED", dashboard.variables.map((v) => v.name));
    const exp = Math.floor(Date.now() / 1000) + EMBED_PREVIEW_TTL_SECONDS;
    return {
      data: {
        token: signEmbedPreviewToken({ dashboard: dashboard.id, display: display as Record<string, unknown>, variables, exp }, context.embedPreviewKey),
        expiresAt: new Date(exp * 1000).toISOString(),
      },
    };
  });

  app.get<{ Params: { id: string } }>(`${base}/impact`, {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Embeds the draft would break",
      description:
        "The active embeds that lock a variable the draft no longer has - publishing it would stop them (they fail closed, " +
        "never showing the dashboard without their restriction). The editor asks before such a publish.",
      pathParameters: ID,
      response: ok(arrayOf(object({ id: UUID, name: { type: "string" }, missing: { type: "array", items: { type: "string" } } }))),
    }),
  }, async (request) => {
    const dashboard = await dashboardOf(request.params.id);
    return { data: await context.dashboardEmbeds.brokenBy(dashboard.id, dashboard.variables) };
  });
}
