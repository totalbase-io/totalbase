import { UUID_PATTERN } from "@totalbase/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  embedClick,
  embedHiddenColumns,
  EMBED_LINK_PREFIX,
  isPreviewToken,
  verifyEmbedPreviewToken,
  verifyEmbedToken,
  type AdminDashboard,
  type AdminDashboardVersionSnapshot,
  type DashboardVariable,
  type EmbedDisplay,
  type EmbedVariableConfig,
} from "@totalbase/dashboards";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { effectiveTimezone } from "../display-preferences.js";
import { dashboardQueryLimits, freshRun, variableValues, type VariableValues } from "./admin-dashboards.js";
import { recordWidgetExport, withoutOptionsQuery, withoutQuery, type ExportAuditBody } from "./app-dashboards.js";
import { serveDashboardFile, verifyDashboardFile, withFileLinks } from "../dashboard-files.js";
import { EMBED_PREVIEW_TTL_SECONDS } from "./admin-dashboard-embeds.js";
import type { DataBody } from "../request-body.js";

/** Where the embed page sends its credential - a link's secret, a portal's token or a preview token; never in a URL the server logs. */
export const EMBED_TOKEN_HEADER = "x-totalbase-embed-token";


interface Embed {
  dashboard: AdminDashboard;
  /** The live version, read once per request - its tabs, widgets and variables are what every route below serves. */
  snapshot: AdminDashboardVersionSnapshot;
  kind: "LINK" | "SIGNED" | "PREVIEW";
  embedId: string | null;
  display: EmbedDisplay;
  /** The published variables the viewer may choose - EDITABLE ones (a variable no embed setting names is EDITABLE). */
  editable: DashboardVariable[];
  /** EDITABLE variables' configured starting values - the bar starts there. */
  starting: Record<string, unknown>;
  /** Bound whatever the request carries: LOCKED values, HIDDEN starting values. */
  fixed: Record<string, unknown>;
}

const notAvailable = () => new TotalBaseError("RESOURCE_NOT_FOUND", "This embed is not available.");

/**
 * The embed a request's credential names (Specification_Dashboards.md §9.5),
 * checked on every request:
 * - a public link (`tbe_…`): its hash finds it;
 * - a portal's token: verified with the instance's embedding secret, it
 *   names a SIGNED embed and gives the values that embed leaves to it;
 * - a preview token: signed by TotalBase for an administrator's drawer,
 *   carrying the embed being designed - embedding needn't be on yet.
 * The embed not revoked nor expired, its dashboard published and its
 * embedding on - otherwise RESOURCE_NOT_FOUND, "denied = missing".
 */
async function resolve(context: AppContext, raw: string): Promise<{ dashboardId: string; kind: Embed["kind"]; embedId: string | null; display: EmbedDisplay; config: Record<string, EmbedVariableConfig>; tokenParams: Record<string, unknown> }> {
  if (raw.startsWith(EMBED_LINK_PREFIX)) {
    const embed = await context.dashboardEmbeds.findByLink(raw);
    if (!embed || embed.type !== "LINK" || embed.revokedAt || (embed.expiresAt && new Date(embed.expiresAt) <= new Date())) throw notAvailable();
    return { dashboardId: embed.dashboard, kind: "LINK", embedId: embed.id, display: embed.display, config: embed.variables, tokenParams: {} };
  }
  if (isPreviewToken(raw)) {
    const preview = verifyEmbedPreviewToken(raw, context.embedPreviewKey, EMBED_PREVIEW_TTL_SECONDS);
    return { dashboardId: preview.dashboard, kind: "PREVIEW", embedId: null, display: preview.display as EmbedDisplay, config: preview.variables as Record<string, EmbedVariableConfig>, tokenParams: {} };
  }
  const [secretKey, maxTtlMinutes] = await Promise.all([
    context.settings.get("dashboards.embed_secret_key"),
    context.settings.get("dashboards.embed_max_ttl_minutes"),
  ]);
  const secret = secretKey ? await context.secrets.decrypt(secretKey).catch(() => "") : "";
  const claims = verifyEmbedToken(raw, secret, maxTtlMinutes * 60);
  const embed = await context.dashboardEmbeds.findById(claims.embed);
  if (!embed || embed.type !== "SIGNED" || embed.revokedAt || (embed.expiresAt && new Date(embed.expiresAt) <= new Date())) throw notAvailable();
  return { dashboardId: embed.dashboard, kind: "SIGNED", embedId: embed.id, display: embed.display, config: embed.variables, tokenParams: claims.params };
}

/**
 * The embed with its variables applied to the published ones - failing
 * closed: a variable it locks that the published version no longer has
 * stops it (EMBED_NEEDS_UPDATE) rather than show the dashboard without the
 * restriction; a portal's token must give every value its embed leaves to
 * it, and nothing else.
 */
async function embedOf(context: AppContext, request: FastifyRequest): Promise<Embed> {
  const raw = request.headers[EMBED_TOKEN_HEADER];
  if (typeof raw !== "string" || !raw) throw new TotalBaseError("EMBED_TOKEN_INVALID", "An embed link or token is required.");
  const resolved = await resolve(context, raw);

  const dashboard = await context.dashboardsAdmin.get(resolved.dashboardId).catch(() => {
    throw notAvailable();
  });
  if (resolved.kind !== "PREVIEW" && !dashboard.embeddingEnabled) throw notAvailable();
  const snapshot = await context.dashboardsAdmin.getLiveSnapshot(dashboard.id);
  if (!snapshot) throw notAvailable();

  const published = snapshot.variables;
  const names = new Set(published.map((v) => v.name));
  const fixed: Record<string, unknown> = {};
  const starting: Record<string, unknown> = {};
  const fromToken = new Set<string>();
  for (const [name, config] of Object.entries(resolved.config)) {
    if (config.mode === "LOCKED") {
      if (!names.has(name)) {
        throw new TotalBaseError("EMBED_NEEDS_UPDATE", `This embed needs updating: "${name}", a variable it locks, is no longer in the dashboard.`);
      }
      if (config.value !== undefined) {
        fixed[name] = config.value;
      } else if (resolved.kind === "SIGNED") {
        if (!(name in resolved.tokenParams)) throw new TotalBaseError("EMBED_TOKEN_INVALID", `The embed token must give "${name}", a variable this embed locks.`);
        fixed[name] = resolved.tokenParams[name];
        fromToken.add(name);
      } else {
        // A preview without a sample value: locked to nothing, never left open.
        fixed[name] = null;
      }
    } else if (names.has(name) && config.value !== undefined) {
      (config.mode === "HIDDEN" ? fixed : starting)[name] = config.value;
    }
  }
  for (const name of Object.keys(resolved.tokenParams)) {
    if (!fromToken.has(name)) throw new TotalBaseError("EMBED_TOKEN_INVALID", `The embed token sets "${name}", which this embed doesn't take from a token.`);
  }
  const closed = new Set(Object.entries(resolved.config).filter(([, c]) => c.mode !== "EDITABLE").map(([name]) => name));
  return {
    dashboard,
    snapshot,
    kind: resolved.kind,
    embedId: resolved.embedId,
    display: resolved.display,
    editable: published.filter((v) => !closed.has(v.name)),
    starting,
    fixed,
  };
}

/** The embed a file link's token names - read before its signature is checked, then checked by it. */
function peekEmbed(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    return (JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { e?: string | null }).e ?? null;
  } catch {
    return null;
  }
}

/** The variables an embed's visitor may change - a click may set only these (D6). */
function editableNames(embed: Embed): Set<string> {
  return new Set(embed.editable.map((v) => v.name));
}

/** The viewer's choices for the editable variables, over their starting values, under what the embed fixes - a locked value is never the browser's. */
function boundValues(embed: Embed, body: DataBody<VariableValues> | undefined): Record<string, unknown> {
  const open = new Set(embed.editable.map((v) => v.name));
  const chosen = Object.fromEntries(Object.entries(variableValues(body)).filter(([name]) => open.has(name)));
  return { ...embed.starting, ...chosen, ...embed.fixed };
}

/** Nobody signed in: no `$USER.*` (a widget using it fails), the instance's zone or the browser's. */
async function embedViewer(context: AppContext, request: FastifyRequest) {
  return { userId: null, timezone: await effectiveTimezone(context, undefined, request.headers["x-totalbase-timezone"]) };
}

/**
 * The sites that may frame an embed page (`frame-ancestors`), from its path:
 * `/admin/embed/<tbe_…>` a link, `/admin/embed/<uuid>` a signed embed - its
 * own sites within dashboards.embed_allowed_origins, all of those when it
 * names none; anything else (the preview, an unknown key) only TotalBase
 * itself. Always TotalBase too: the drawer's preview frames it.
 */
export async function embedFrameAncestors(context: AppContext, path: string): Promise<string> {
  const key = decodeURIComponent(path.slice("/admin/embed/".length).split("/")[0] ?? "");
  const instance = await context.settings.get("dashboards.embed_allowed_origins");
  let embed = null;
  if (key.startsWith(EMBED_LINK_PREFIX)) embed = await context.dashboardEmbeds.findByLink(key);
  else if (UUID_PATTERN.test(key)) embed = await context.dashboardEmbeds.findById(key);
  const sites = !embed || embed.revokedAt ? [] : embed.origins.length > 0 ? embed.origins.filter((o) => instance.includes(o)) : instance;
  return ["'self'", ...sites].join(" ");
}

/**
 * Dashboard embeds (Specification_Dashboards.md §9.5) - the App's dashboard
 * routes (app-dashboards.ts) for a visitor with no TotalBase account: the
 * same published snapshot, widgets run by id, never SQL; access from the
 * embed's credential instead of roles; the dashboard's id never sent.
 */
export function registerEmbedDashboardsRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/embed/api/dashboard", async (request) => {
    const embed = await embedOf(context, request);
    if (embed.embedId) await context.dashboardEmbeds.touch(embed.embedId);
    return {
      data: {
        kind: embed.kind,
        name: embed.dashboard.name,
        description: embed.dashboard.description,
        refreshIntervalSeconds: embed.dashboard.refreshIntervalSeconds,
        display: embed.display,
        tabs: embed.snapshot.tabs,
        startingValues: embed.starting,
        // No user: the instance's language (a `locale` URL parameter may override it).
        language: await context.settings.get("system.language"),
      },
    };
  });

  app.get("/embed/api/dashboard/widgets", async (request) => {
    const embed = await embedOf(context, request);
    return {
      data: embed.snapshot.widgets.map((widget) => {
        const { dashboard: _id, ...rest } = withoutQuery(widget);
        // Only the clicks an embed runs (D6): a FILTER on a variable its visitor changes, a URL marked inEmbeds.
        const { click: _click, ...config } = rest.config;
        const click = embedClick(rest.config, editableNames(embed));
        return { ...rest, config: click ? { ...config, click } : config };
      }),
    };
  });

  app.get("/embed/api/dashboard/variables", async (request) => {
    const embed = await embedOf(context, request);
    return { data: (await context.dashboardsAdmin.withDefaultValues(embed.editable, null)).map(withoutOptionsQuery) };
  });

  app.post<{ Params: { name: string }; Body: DataBody<VariableValues> }>("/embed/api/dashboard/variables/:name/options", async (request) => {
    const embed = await embedOf(context, request);
    if (!embed.editable.some((v) => v.name === request.params.name)) throw new TotalBaseError("DASHBOARD_VARIABLE_NOT_FOUND", `No variable "${request.params.name}".`);
    return {
      data: await context.dashboardsAdmin.variableOptions(
        embed.dashboard.id,
        request.params.name,
        "PUBLISHED",
        await dashboardQueryLimits(context),
        await embedViewer(context, request),
        boundValues(embed, request.body),
      ),
    };
  });

  // An embed's file by its signed link (D14) - no header: the link names the embed, which must still be live; a file
  // that isn't PUBLIC needs the embed's allowFiles now, not only when the link was signed.
  app.get<{ Params: { widgetId: string; fileId: string }; Querystring: Record<string, string | undefined> }>("/embed/api/dashboard/widgets/:widgetId/files/:fileId", async (request, reply) => {
    const token = request.query.token;
    const claims = verifyDashboardFile(context.dashboardFilesKey, token, { widget: request.params.widgetId, file: request.params.fileId, embed: peekEmbed(token) });
    if (claims.e === "preview") return serveDashboardFile(context, reply, request.params.fileId, request.query, () => true);
    const embed = claims.e ? await context.dashboardEmbeds.findById(claims.e) : null;
    const dashboard = embed ? await context.dashboardsAdmin.get(embed.dashboard).catch(() => null) : null;
    const live = embed && dashboard && dashboard.id === claims.d && dashboard.embeddingEnabled && !embed.revokedAt && (!embed.expiresAt || new Date(embed.expiresAt).getTime() > Date.now());
    if (!live) throw new TotalBaseError("DASHBOARD_FILE_TOKEN_INVALID", "This file's link isn't valid or has expired - reload the dashboard for a new one.");
    return serveDashboardFile(context, reply, request.params.fileId, request.query, (visibility) => visibility === "PUBLIC" || embed.display.allowFiles === true);
  });

  // A download from an embed (D8): only where it allows them (display.allowExport) - its EXPORT entry names the embed.
  app.post<{ Params: { widgetId: string }; Body: DataBody<ExportAuditBody> }>("/embed/api/dashboard/widgets/:widgetId/exports", async (request, reply) => {
    const embed = await embedOf(context, request);
    if (embed.display.allowExport !== true) throw new TotalBaseError("ACTION_DENIED", "This embed doesn't allow downloads (its display.allowExport is off).");
    const widget = embed.snapshot.widgets.find((w) => w.id === request.params.widgetId);
    if (!widget) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${request.params.widgetId}`);
    const id = await recordWidgetExport(context, request, { type: "SYSTEM", id: null }, embed.dashboard.id, widget.id, request.body, embed.embedId);
    reply.code(201);
    return { data: { id } };
  });

  app.post<{ Params: { widgetId: string }; Body: DataBody<VariableValues> & { fresh?: boolean } }>("/embed/api/dashboard/widgets/:widgetId/data", async (request) => {
    const embed = await embedOf(context, request);
    // Its files' links (D14): one that isn't PUBLIC only where the embed allows files.
    const result = await withFileLinks(context, await context.dashboardsAdmin.executePublishedWidget(
      embed.dashboard.id,
      request.params.widgetId,
      { ...(await dashboardQueryLimits(context)), ...freshRun(request.body) },
      await embedViewer(context, request),
      boundValues(embed, request.body),
    ), {
      dashboardId: embed.dashboard.id,
      widgetId: request.params.widgetId,
      route: `/embed/api/dashboard/widgets/${request.params.widgetId}/files`,
      embed: { id: embed.embedId ?? "preview", allowFiles: embed.display.allowFiles === true },
    });
    // The _ columns only a click reads that doesn't run here never leave the server (D6).
    const widget = embed.snapshot.widgets.find((w) => w.id === request.params.widgetId);
    const hidden = widget ? embedHiddenColumns(widget.config, editableNames(embed)) : new Set<string>();
    if (hidden.size === 0) return { data: result };
    return {
      data: {
        ...result,
        columns: result.columns.filter((c) => !hidden.has(c.name)),
        rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !hidden.has(name)))),
      },
    };
  });
}
