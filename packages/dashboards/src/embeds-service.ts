import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@totalbase/database";
import { DASHBOARD_REFRESH_INTERVALS } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { UUID_PATTERN } from "@totalbase/shared";
import { isEmbedVariableValue } from "./embed-token.js";
import type { DashboardVariable } from "./variables.js";

/**
 * Dashboard embeds (Dashboards.md §9.5): each way a published
 * dashboard is shown outside TotalBase - a public LINK, or a SIGNED embed a
 * portal's backend signs tokens for. An embed holds how it looks
 * (`display`), what each variable is (`variables`), the sites that may frame
 * it (`origins`, within dashboards.embed_allowed_origins) and an optional
 * expiry; revoking it stops it at once. The dashboard's id is never in a URL
 * or a token - a link carries its own random secret, a token names the
 * embed.
 */
export type EmbedType = "LINK" | "SIGNED";
export type EmbedVariableMode = "EDITABLE" | "HIDDEN" | "LOCKED";
export type EmbedTheme = "light" | "dark" | "auto";

export interface EmbedDisplay {
  theme?: EmbedTheme;
  titled?: boolean;
  transparent?: boolean;
  /** Overrides the dashboard's auto-refresh: one of its intervals, or null for off; absent = the dashboard's. */
  refreshSeconds?: number | null;
  /** A widget's ⋮ offers CSV, Excel and image downloads (D8) - off by default; the data is in the browser either way. */
  allowExport?: boolean;
  /**
   * A file the queries return that isn't PUBLIC (a photo) is served to its visitors (D14) - off by default: a public
   * link doesn't show PRIVATE images without this decision.
   */
  allowFiles?: boolean;
}

export interface EmbedVariableConfig {
  mode: EmbedVariableMode;
  /** EDITABLE/HIDDEN: its starting value; LOCKED: its value - absent on a SIGNED embed means the token gives it. */
  value?: unknown;
}

export interface DashboardEmbed {
  id: string;
  dashboard: string;
  name: string;
  type: EmbedType;
  display: EmbedDisplay;
  variables: Record<string, EmbedVariableConfig>;
  /** The one widget it shows (Dashboards.md §9.5) - null, the whole dashboard. */
  widget: string | null;
  origins: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** LINK only, for an administrator: the link's secret (`tbe_…`) - copied again whenever needed. */
  link: string | null;
}

export interface EmbedInput {
  name?: string;
  type?: EmbedType;
  display?: unknown;
  variables?: unknown;
  /** A widget of the published version, or null for the whole dashboard. */
  widget?: string | null;
  origins?: unknown;
  expiresAt?: string | null;
}

/** Encrypts a link's secret for storage - the master key's cipher (apps/server wires @totalbase/secrets). */
export interface EmbedCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

interface EmbedRow {
  id: string;
  dashboard: string;
  name: string;
  type: EmbedType;
  display: EmbedDisplay;
  variables: Record<string, EmbedVariableConfig>;
  widget: string | null;
  origins: string[];
  link_ciphertext: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, dashboard, name, type, display, variables, widget, origins, link_ciphertext, expires_at, revoked_at, last_used_at, created_at, updated_at";
export const EMBED_LINK_PREFIX = "tbe_";
const THEMES = new Set(["light", "dark", "auto"]);
const MODES = new Set(["EDITABLE", "HIDDEN", "LOCKED"]);
const REFRESH = new Set<number>(DASHBOARD_REFRESH_INTERVALS.map((i) => i.seconds));

function invalid(message: string): TotalBaseError {
  return new TotalBaseError("DASHBOARD_EMBED_INVALID", message);
}

export function hashEmbedLink(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function validateName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 32) throw invalid("An embed needs a name of 1 to 32 characters.");
  return name;
}

function validateDisplay(raw: unknown): EmbedDisplay {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("display must be an object.");
  const { theme, titled, transparent, refreshSeconds, allowExport, allowFiles, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid(`display has no ${Object.keys(rest).join(", ")} - it takes: theme, titled, transparent, refreshSeconds, allowExport, allowFiles.`);
  const display: EmbedDisplay = {};
  if (theme !== undefined) {
    if (typeof theme !== "string" || !THEMES.has(theme)) throw invalid("display.theme is light, dark or auto.");
    display.theme = theme as EmbedTheme;
  }
  for (const [key, value] of [["titled", titled], ["transparent", transparent], ["allowExport", allowExport], ["allowFiles", allowFiles]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw invalid(`display.${key} is true or false.`);
    display[key] = value;
  }
  if (refreshSeconds !== undefined) {
    if (refreshSeconds !== null && (typeof refreshSeconds !== "number" || !REFRESH.has(refreshSeconds))) {
      throw invalid(`display.refreshSeconds is null (off) or one of ${[...REFRESH].join(", ")}.`);
    }
    display.refreshSeconds = refreshSeconds as number | null;
  }
  return display;
}

function validateVariables(raw: unknown, type: EmbedType, known: readonly string[]): Record<string, EmbedVariableConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("variables must be an object, by variable name.");
  const out: Record<string, EmbedVariableConfig> = {};
  for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
    // A variable the dashboard doesn't have would lock nothing (DB28).
    if (!known.includes(name)) throw invalid(`The dashboard has no variable "${name}" - its variables: ${known.join(", ") || "none"}.`);
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const unknown = Object.keys(config).find((k) => k !== "mode" && k !== "value");
      if (unknown) throw invalid(`variables.${name} has no "${unknown}" - it takes: mode, value.`);
    }
    const { mode, value } = (config ?? {}) as { mode?: unknown; value?: unknown };
    if (typeof mode !== "string" || !MODES.has(mode)) throw invalid(`Variable "${name}": mode is EDITABLE, HIDDEN or LOCKED.`);
    if (value !== undefined && !isEmbedVariableValue(value)) throw invalid(`Variable "${name}": its value is a plain value, a list or a { from, to }.`);
    // A public link has no backend to fill a locked value in: it holds it.
    if (mode === "LOCKED" && type === "LINK" && (value === undefined || value === null || value === "")) {
      throw invalid(`Variable "${name}" is locked: a public link needs its value.`);
    }
    out[name] = value === undefined ? { mode: mode as EmbedVariableMode } : { mode: mode as EmbedVariableMode, value };
  }
  return out;
}

function validateOrigins(raw: unknown, allowed: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) throw invalid("origins is a list of sites.");
  const outside = (raw as string[]).filter((o) => !allowed.includes(o));
  if (outside.length > 0) {
    throw invalid(`${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} among the sites that may embed (Settings › Dashboards › Embedding).`);
  }
  return [...new Set(raw as string[])];
}

function validateExpiry(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const date = typeof raw === "string" ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) throw invalid("expiresAt is a date and time, or null for never.");
  if (date.getTime() <= Date.now()) throw invalid("expiresAt is in the past.");
  return date.toISOString();
}

export class DashboardEmbedsService {
  constructor(
    private readonly database: Database,
    private readonly cipher: EmbedCipher,
  ) {}

  private toEmbed(row: EmbedRow): DashboardEmbed {
    return {
      id: row.id,
      dashboard: row.dashboard,
      name: row.name,
      type: row.type,
      display: row.display ?? {},
      variables: row.variables ?? {},
      widget: row.widget,
      origins: row.origins ?? [],
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      link: row.link_ciphertext ? this.cipher.decrypt(row.link_ciphertext) : null,
    };
  }

  private static mapUnique(error: unknown): never {
    if (error instanceof TotalBaseError && error.code === "UNIQUE_VIOLATION") {
      throw new TotalBaseError("DASHBOARD_EMBED_NAME_DUPLICATE", "This dashboard already has an embed with this name.");
    }
    throw error;
  }

  async list(dashboardId: string): Promise<DashboardEmbed[]> {
    const { rows } = await this.database.query<EmbedRow>(
      `SELECT ${COLUMNS} FROM totalbase.dashboards_embeds WHERE dashboard = $1 ORDER BY created_at`,
      [dashboardId],
    );
    return rows.map((row) => this.toEmbed(row));
  }

  async get(dashboardId: string, embedId: string): Promise<DashboardEmbed> {
    const { rows } = await this.database.query<EmbedRow>(
      `SELECT ${COLUMNS} FROM totalbase.dashboards_embeds WHERE id = $1 AND dashboard = $2`,
      [embedId, dashboardId],
    );
    if (!rows[0]) throw new TotalBaseError("DASHBOARD_EMBED_NOT_FOUND", "Embed not found.");
    return this.toEmbed(rows[0]);
  }

  /** `allowedOrigins`: dashboards.embed_allowed_origins - an embed's sites are some of these. */
  /** The variables an embed may set: the live version's - the draft's while it has none. */
  private async variableNames(dashboardId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ variables: { name: string }[] | null }>(
      `SELECT coalesce((SELECT v.variables_snapshot FROM totalbase.dashboards_versions v WHERE v.dashboard = d.id ORDER BY v.version DESC LIMIT 1), d.variables) AS variables
       FROM totalbase.dashboards d WHERE d.id = $1`,
      [dashboardId],
    );
    return (rows[0]?.variables ?? []).map((v) => v.name);
  }

  /** The widgets an embed may show: the live version's - the draft's while it has none. */
  private async widgetIds(dashboardId: string): Promise<string[]> {
    const { rows } = await this.database.query<{ id: string }>(
      `SELECT w->>'id' AS id FROM jsonb_array_elements(coalesce(
         (SELECT v.widgets_snapshot FROM totalbase.dashboards_versions v WHERE v.dashboard = $1 ORDER BY v.version DESC LIMIT 1),
         (SELECT jsonb_agg(jsonb_build_object('id', dw.id)) FROM totalbase.dashboards_widgets dw WHERE dw.dashboard = $1),
         '[]'::jsonb)) w`,
      [dashboardId],
    );
    return rows.map((r) => r.id);
  }

  /** An embed's (or a preview's) widget: null for the whole dashboard, else one of the published version's. */
  async validateWidget(dashboardId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || !UUID_PATTERN.test(raw) || !(await this.widgetIds(dashboardId)).includes(raw)) {
      throw invalid(`The dashboard has no widget ${String(raw)} - an embed shows one of its published widgets, or null for the whole dashboard.`);
    }
    return raw;
  }

  async create(dashboardId: string, input: EmbedInput, createdBy: string | null, allowedOrigins: readonly string[]): Promise<DashboardEmbed> {
    const type = input.type;
    if (type !== "LINK" && type !== "SIGNED") throw invalid("type is LINK or SIGNED.");
    const name = validateName(input.name);
    const display = validateDisplay(input.display);
    const variables = validateVariables(input.variables, type, await this.variableNames(dashboardId));
    const widget = await this.validateWidget(dashboardId, input.widget);
    const origins = validateOrigins(input.origins, allowedOrigins);
    const expiresAt = validateExpiry(input.expiresAt);
    const secret = type === "LINK" ? `${EMBED_LINK_PREFIX}${randomBytes(24).toString("base64url")}` : null;
    try {
      const { rows } = await this.database.query<EmbedRow>(
        `INSERT INTO totalbase.dashboards_embeds (dashboard, name, type, display, variables, widget, origins, link_hash, link_ciphertext, expires_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)
         RETURNING ${COLUMNS}`,
        [dashboardId, name, type, JSON.stringify(display), JSON.stringify(variables), widget, origins, secret ? hashEmbedLink(secret) : null, secret ? this.cipher.encrypt(secret) : null, expiresAt, createdBy],
      );
      return this.toEmbed(rows[0]!);
    } catch (error) {
      DashboardEmbedsService.mapUnique(error);
    }
  }

  /** Everything but its type and its link - a link changed stays the same URL, so the pages using it follow. */
  async update(dashboardId: string, embedId: string, patch: EmbedInput, allowedOrigins: readonly string[]): Promise<DashboardEmbed> {
    const current = await this.get(dashboardId, embedId);
    if (patch.type !== undefined && patch.type !== current.type) throw invalid("An embed's type doesn't change - create another one.");
    const sets: string[] = [];
    const values: unknown[] = [embedId];
    const set = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.name !== undefined) set("name", validateName(patch.name));
    if (patch.display !== undefined) set("display", JSON.stringify(validateDisplay(patch.display)), "::jsonb");
    if (patch.variables !== undefined) set("variables", JSON.stringify(validateVariables(patch.variables, current.type, await this.variableNames(dashboardId))), "::jsonb");
    // The whole dashboard or one widget: changed like its display - the same link and tokens show the new one.
    if (patch.widget !== undefined) set("widget", await this.validateWidget(dashboardId, patch.widget));
    if (patch.origins !== undefined) set("origins", validateOrigins(patch.origins, allowedOrigins));
    if (patch.expiresAt !== undefined) set("expires_at", validateExpiry(patch.expiresAt));
    if (sets.length === 0) return current;
    try {
      const { rows } = await this.database.query<EmbedRow>(
        `UPDATE totalbase.dashboards_embeds SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        values,
      );
      return this.toEmbed(rows[0]!);
    } catch (error) {
      DashboardEmbedsService.mapUnique(error);
    }
  }

  /** Stops it at once, for good - its link or tokens never work again (another embed is the way back). */
  async revoke(dashboardId: string, embedId: string): Promise<DashboardEmbed> {
    await this.get(dashboardId, embedId);
    const { rows } = await this.database.query<EmbedRow>(
      `UPDATE totalbase.dashboards_embeds SET revoked_at = coalesce(revoked_at, now()), updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [embedId],
    );
    return this.toEmbed(rows[0]!);
  }

  async delete(dashboardId: string, embedId: string): Promise<void> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.dashboards_embeds WHERE id = $1 AND dashboard = $2`, [embedId, dashboardId]);
    if (rowCount === 0) throw new TotalBaseError("DASHBOARD_EMBED_NOT_FOUND", "Embed not found.");
  }

  /** The embed a credential names, whatever its state - the caller checks revoked, expired, its type. */
  async findByLink(secret: string): Promise<DashboardEmbed | null> {
    const { rows } = await this.database.query<EmbedRow>(
      `SELECT ${COLUMNS} FROM totalbase.dashboards_embeds WHERE link_hash = $1`,
      [hashEmbedLink(secret)],
    );
    return rows[0] ? this.toEmbed(rows[0]) : null;
  }

  async findById(embedId: string): Promise<DashboardEmbed | null> {
    const { rows } = await this.database.query<EmbedRow>(`SELECT ${COLUMNS} FROM totalbase.dashboards_embeds WHERE id = $1`, [embedId]);
    return rows[0] ? this.toEmbed(rows[0]) : null;
  }

  /** Records a use - at most once a minute, not a write per widget request. */
  async touch(embedId: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.dashboards_embeds SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [embedId],
    );
  }

  /**
   * The embeds a draft would break: a variable they lock is gone, or the one
   * widget they show - an embed fails closed rather than show the dashboard
   * without its restriction, or the whole dashboard instead of its widget.
   * The editor asks before a publish that does this.
   */
  async brokenBy(
    dashboardId: string,
    variables: readonly DashboardVariable[],
    widgetIds: readonly string[],
  ): Promise<Array<{ id: string; name: string; missing: string[]; widgetMissing: boolean }>> {
    const names = new Set(variables.map((v) => v.name));
    const widgets = new Set(widgetIds);
    return (await this.list(dashboardId))
      .filter((embed) => !embed.revokedAt)
      .map((embed) => ({
        id: embed.id,
        name: embed.name,
        missing: Object.entries(embed.variables).filter(([name, config]) => config.mode === "LOCKED" && !names.has(name)).map(([name]) => name),
        widgetMissing: embed.widget !== null && !widgets.has(embed.widget),
      }))
      .filter((embed) => embed.missing.length > 0 || embed.widgetMissing);
  }
}

export { validateDisplay as validateEmbedDisplay, validateVariables as validateEmbedVariables };
