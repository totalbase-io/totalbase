import { isIP } from "node:net";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { COLOR_MODES, HEX_COLOR, isProjectUserColumn, isRegionalFormat, isUiLanguage, LOCKDOWN_MODES, LOCKDOWN_WHEN, LOGIN_CARD_POSITIONS, LOGIN_HEADLINE_MAX, LOGIN_INTRO_MAX, LOGIN_LAYOUTS, MCP_INSTRUCTIONS_MAX, MCP_MODES, NEUTRAL_COLORS, parseCronExpression, REGIONAL_FORMATS, UI_LANGUAGES, UUID_PATTERN, validateCustomCss } from "@totalbase/shared";
import { SETTINGS_DEFAULTS, settingBounds, type SettingKey, type SettingsRegistry } from "./registry.js";
import {
  SYSTEM_EMAIL_SLOTS,
  validateLinkTemplate,
  validateMailFooter,
  validateMailTemplate,
  validatePublicUrl,
} from "./mail-templates.js";
import { lockdownWindowProblem, validateLockdownInstant } from "./lockdown.js";


const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** `workflows.http_allowed_hosts`: each entry a hostname, an IP address or a CIDR range. */
function validateAllowedHosts(value: unknown): string | null {
  for (const entry of value as string[]) {
    const [address, prefix, extra] = entry.trim().split("/");
    const family = isIP(address ?? "");
    if (prefix === undefined ? family !== 0 || HOSTNAME.test(entry.trim()) : family !== 0 && extra === undefined && /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)) continue;
    return `"${entry}" is not a hostname, an IP address or a CIDR range.`;
  }
  return null;
}

/**
 * Per-key value checks, run on every write - for settings whose value
 * has structure beyond its type (URLs, templates). Returns a problem
 * message, or null when the value is fine.
 */
/**
 * `security.cors_origins`: each entry an origin a browser sends - `https://app.example.com`, a port at most - nothing
 * a credentialed CORS answer must never reflect: `null` (any sandboxed page or file sends it), `*`, a path.
 */
function validateCorsOrigins(value: unknown): string | null {
  for (const entry of value as string[]) {
    let origin: string | undefined;
    try {
      const url = new URL(entry);
      origin = (url.protocol === "https:" || url.protocol === "http:") ? url.origin : undefined;
    } catch {
      origin = undefined;
    }
    if (origin !== entry) return `"${entry}" is not an origin - expected the scheme, the host and a port at most, e.g. https://app.example.com.`;
  }
  return null;
}

/** `security.trusted_proxies`: each entry an IP address or a CIDR range - what Fastify takes, never a name or `*`. */
function validateTrustedProxies(value: unknown): string | null {
  for (const entry of value as string[]) {
    const [address, prefix, extra] = entry.trim().split("/");
    const family = isIP(address ?? "");
    if (family !== 0 && extra === undefined && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))) continue;
    return `"${entry}" is not an IP address or a CIDR range.`;
  }
  return null;
}

const SETTINGS_VALIDATORS: Partial<Record<SettingKey, (value: unknown) => string | null>> = {
  "system.public_url": validatePublicUrl,
  "security.cors_origins": validateCorsOrigins,
  "security.trusted_proxies": validateTrustedProxies,
  "system.instance_name": (value) =>
    typeof value === "string" && value.trim() && value.length <= 64 ? null : "Expected a name of 1-64 characters.",
  "lockdown.from": validateLockdownInstant,
  "lockdown.until": validateLockdownInstant,
  "lockdown.message": (value) => ((value as string).length <= 500 ? null : "At most 500 characters."),
  "lockdown.when": (value) => (LOCKDOWN_WHEN.includes(value as never) ? null : `Expected one of ${LOCKDOWN_WHEN.join(", ")}.`),
  "lockdown.mode": (value) => (LOCKDOWN_MODES.includes(value as never) ? null : `Expected one of ${LOCKDOWN_MODES.join(", ")}.`),
  "lockdown.recurring_schedule": (value) => {
    try {
      parseCronExpression(value as string);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  },
  "lockdown.allowed_roles": (value) =>
    (value as string[]).every((id) => UUID_PATTERN.test(id)) && new Set(value as string[]).size === (value as string[]).length ? null : "Expected a list of distinct role ids.",
  "workflows.http_allowed_hosts": validateAllowedHosts,
  // Admin_UI.md §4.1.1 - every one of these is public.
  "system.logo": (value) => (value === "" || UUID_PATTERN.test(value as string) ? null : "Expected a file id, or empty."),
  "appearance.login_background": (value) => (value === "" || UUID_PATTERN.test(value as string) ? null : "Expected a file id, or empty."),
  "appearance.neutral_color": (value) => ((NEUTRAL_COLORS as readonly unknown[]).includes(value) ? null : `Expected one of ${NEUTRAL_COLORS.join(", ")}.`),
  "appearance.color_mode": (value) => (COLOR_MODES.includes(value as never) ? null : `Expected one of ${COLOR_MODES.join(", ")}.`),
  "appearance.primary_color": (value) => (value === "" || HEX_COLOR.test(value as string) ? null : "Expected a color as #rrggbb, or empty."),
  "appearance.login_layout": (value) => (LOGIN_LAYOUTS.includes(value as never) ? null : `Expected one of ${LOGIN_LAYOUTS.join(", ")}.`),
  "appearance.login_card_position": (value) => (LOGIN_CARD_POSITIONS.includes(value as never) ? null : `Expected one of ${LOGIN_CARD_POSITIONS.join(", ")}.`),
  "appearance.login_headline": (value) => ((value as string).length <= LOGIN_HEADLINE_MAX ? null : `At most ${LOGIN_HEADLINE_MAX} characters.`),
  "appearance.login_intro": (value) => ((value as string).length <= LOGIN_INTRO_MAX ? null : `At most ${LOGIN_INTRO_MAX} characters.`),
  "appearance.custom_css": validateCustomCss,
  "maps.tiles": (value) => (value === "OPENSTREETMAP" || value === "MAPBOX" ? null : 'Expected "OPENSTREETMAP" or "MAPBOX".'),
  // Public by design (it reaches every viewer's browser): a secret token must never be stored here.
  "maps.mapbox_token": (value) =>
    value === "" || /^pk\.[A-Za-z0-9._-]{10,}$/.test(value as string)
      ? null
      : /^sk\./.test(value as string)
        ? "This is a secret token (sk.) - use a public one (pk.), restricted to this instance's URL in your Mapbox account."
        : "Expected a Mapbox public token (pk.…), or empty.",
  "maps.default_view": (value) => {
    if (value === "") return null;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d{1,2})\s*$/.exec(value as string);
    return match && Math.abs(Number(match[1])) <= 90 && Math.abs(Number(match[2])) <= 180 && Number(match[3]) <= 20
      ? null
      : "Expected latitude, longitude, zoom - e.g. -24.79, -65.41, 12.";
  },
  "maps.mapbox_style": (value) => (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(value as string) ? null : "Expected username/style_id, e.g. mapbox/streets-v12."),
  // A PostgreSQL role's name, as it is (quoted where used): at most NAMEDATALEN - 1 bytes. Whether it exists and
  // TotalBase can hand it the query function is PostgreSQL's to say, when a widget runs and on Status.
  "dashboards.query_role": (value) =>
    value === "" || (value === (value as string).trim() && Buffer.byteLength(value as string) <= 63)
      ? null
      : "Expected a PostgreSQL role's name (at most 63 bytes, no surrounding spaces), or empty.",
  // An origin, exactly - what a browser sends and frame-ancestors matches: scheme, host, port; no path.
  "dashboards.embed_allowed_origins": (value) => {
    for (const entry of value as string[]) {
      let url: URL | null = null;
      try {
        url = new URL(entry);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== entry) {
        return `"${entry}" is not an origin - write it as https://app.example.com, with no path or trailing slash.`;
      }
    }
    return null;
  },
  "dataviews.toolbar_mode": (value) => (value === "auto" || value === "full" || value === "compact" ? null : 'Expected "auto", "full" or "compact".'),
  "dataviews.record_content_width": (value) => (value === "narrow" || value === "wide" || value === "full" ? null : 'Expected "narrow", "wide" or "full".'),
  "dataviews.custom_content_width": (value) => (value === "narrow" || value === "wide" || value === "full" ? null : 'Expected "narrow", "wide" or "full".'),
  "dataviews.table_margin": (value) => (value === "none" || value === "compact" || value === "normal" ? null : 'Expected "none", "compact" or "normal".'),
  "dataviews.content_align": (value) => (value === "left" || value === "center" || value === "right" ? null : 'Expected "left", "center" or "right".'),
  "mcp.mode": (value) => (MCP_MODES.includes(value as never) ? null : `Expected one of ${MCP_MODES.join(", ")}.`),
  "mcp.instructions": (value) => ((value as string).length <= MCP_INSTRUCTIONS_MAX ? null : `At most ${MCP_INSTRUCTIONS_MAX} characters.`),
  // What a request's Host header may be - a hostname, with a port or not: localhost:3030, totalbase.example.com.
  "mcp.allowed_hosts": (value) => {
    for (const entry of value as string[]) {
      const [host, port, extra] = entry.trim().split(":");
      if (extra === undefined && (HOSTNAME.test(host ?? "") || isIP(host ?? "") === 4) && (port === undefined || (/^\d{1,5}$/.test(port) && Number(port) <= 65_535))) continue;
      return `"${entry}" is not a host - write it as totalbase.example.com or localhost:3030.`;
    }
    return null;
  },
  "system.language": (value) => (isUiLanguage(value) ? null : `Expected one of ${UI_LANGUAGES.map((l) => l.code).join(", ")}.`),
  "system.regional_format": (value) => (value === "" || isRegionalFormat(value) ? null : `Expected empty or one of ${REGIONAL_FORMATS.join(", ")}.`),
  "app.menu_groups_open": (value) => (value === "CURRENT" || value === "OPEN" || value === "CLOSED" ? null : 'Expected "CURRENT", "OPEN" or "CLOSED".'),
  "app.menu_search": (value) => (value === "AUTO" || value === "ALWAYS" || value === "NEVER" ? null : 'Expected "AUTO", "ALWAYS" or "NEVER".'),
  "mfa.required": (value) => (value === "NONE" || value === "EVERYONE" || value === "ROLES" ? null : 'Expected "NONE", "EVERYONE" or "ROLES".'),
  "mfa.required_roles": (value) =>
    (value as string[]).every((id) => UUID_PATTERN.test(id)) && new Set(value as string[]).size === (value as string[]).length ? null : "Expected a list of distinct role ids.",
  "app.menu_mode": (value) => (value === "TREE" || value === "SIDEBAR" ? null : 'Expected "TREE" or "SIDEBAR".'),
  "app.shell": (value) => (value === "SHARED" || value === "STANDALONE" ? null : 'Expected "SHARED" or "STANDALONE".'),
  "app.menu_header": (value) => (["LOGO_AND_NAME", "LOGO", "NAME", "NONE"].includes(value as string) ? null : 'Expected "LOGO_AND_NAME", "LOGO", "NAME" or "NONE".'),
  "files.storage_provider": (value) => (value === "local" || value === "s3" ? null : 'Expected "local" or "s3".'),
  "backups.destination": (value) => (value === "local" || value === "s3" ? null : 'Expected "local" or "s3".'),
  "backups.schedule": (value) => {
    try {
      parseCronExpression(value as string);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  },
  "backups.local_path": (value) => (isAbsolute(value as string) ? null : "Expected an absolute path, e.g. /var/lib/totalbase/backups."),
  "s3.endpoint": (value) => {
    if (value === "") return null;
    try {
      const url = new URL(value as string);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.search && !url.hash && !url.username) return null;
    } catch {
      // falls through
    }
    return "Expected the service's URL, e.g. https://s3.us-east-1.amazonaws.com or http://minio:9000.";
  },
  "s3.region": (value) => (/^[a-z0-9-]{1,32}$/.test(value as string) ? null : "Expected a region such as us-east-1 or auto."),
  // S3's bucket naming rules, the subset every compatible service accepts.
  "s3.bucket": (value) => (value === "" || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value as string) ? null : "Expected a bucket name: 3-63 lowercase letters, digits, dots and hyphens."),
  "s3.prefix": (value) => {
    const prefix = value as string;
    if (prefix === "") return null;
    if (prefix.startsWith("/") || prefix.split("/").some((segment) => segment === "." || segment === "..") || prefix.length > 256) {
      return "Expected a folder path such as production/ - no leading slash, no . or .. segments.";
    }
    return null;
  },
  "files.transforms.presets_json": (value) => {
    try {
      const parsed: unknown = JSON.parse(value as string);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? null : "Expected a JSON object.";
    } catch {
      return "Expected valid JSON.";
    }
  },
  "auth.registration_default_role": (value) => (value === "" || UUID_PATTERN.test(value as string) ? null : "Expected a role id, or empty for none."),
  "auth.registration_columns": (value) =>
    Array.isArray(value) && value.every((column) => typeof column === "string" && /^[a-z_][a-z0-9_]*$/.test(column)) && new Set(value).size === value.length
      ? null
      : "Expected a list of distinct column names.",
  "auth.links.invitation": validateLinkTemplate,
  "auth.links.password_reset": validateLinkTemplate,
  "auth.links.email_verification": validateLinkTemplate,
  ...Object.fromEntries(
    SYSTEM_EMAIL_SLOTS.map((slot) => [`mail.templates.${slot}`, (value: unknown) => validateMailTemplate(slot, value)]),
  ),
  "mail.footer": validateMailFooter,
};

/**
 * Checks that need the database, run inside the write's own transaction
 * (after the type and SETTINGS_VALIDATORS checks). Same contract: a
 * problem message, or null.
 */
/** A file every visitor's browser will load unauthenticated: it exists, it is PUBLIC and it is an image. */
async function validatePublicImage(client: Queryable, value: unknown): Promise<string | null> {
  if (value === "") return null;
  const { rows } = await client.query<{ visibility: string; mime_type: string }>(
    `SELECT visibility, mime_type FROM totalbase.files WHERE id = $1`,
    [value],
  );
  if (!rows[0]) return "No file with that id.";
  if (rows[0].visibility !== "PUBLIC") return "The file must be public - it is shown before anyone signs in.";
  if (!rows[0].mime_type.startsWith("image/")) return "The file must be an image.";
  return null;
}

const SETTINGS_DATABASE_VALIDATORS: Partial<Record<SettingKey, (client: Queryable, value: unknown) => Promise<string | null>>> = {
  "system.logo": validatePublicImage,
  "appearance.login_background": validatePublicImage,
  // Administration.md §7.9: Files stores in S3 only through an enabled connection,
  // and the connection stays on while anything is stored there.
  "files.storage_provider": async (client, value) => {
    if (value !== "s3") return null;
    const { rows } = await client.query(`SELECT 1 FROM totalbase.settings WHERE key = 's3.enabled' AND value = 'true'::jsonb`);
    return rows[0] ? null : "Enable S3 storage (Settings › S3) before storing files in it.";
  },
  "s3.enabled": async (client, value) => {
    if (value !== false) return null;
    const { rows } = await client.query<{ provider: boolean; stored: boolean; backups: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM totalbase.settings WHERE key = 'files.storage_provider' AND value = '"s3"'::jsonb) AS provider,
              EXISTS (SELECT 1 FROM totalbase.files WHERE storage_provider = 's3') AS stored,
              EXISTS (SELECT 1 FROM totalbase.settings WHERE key = 'backups.destination' AND value = '"s3"'::jsonb) AS backups`,
    );
    if (rows[0]!.provider) return "Files stores new uploads in S3 storage - switch its storage provider back to Local disk first.";
    if (rows[0]!.stored) return "Files still holds files stored in S3 storage - they would no longer be served.";
    if (rows[0]!.backups) return "Backups are written to S3 storage - switch their destination back to Local disk first.";
    return null;
  },
  // Administration.md §12.3: backups go to S3 only through an enabled connection.
  "backups.destination": async (client, value) => {
    if (value !== "s3") return null;
    const { rows } = await client.query(`SELECT 1 FROM totalbase.settings WHERE key = 's3.enabled' AND value = 'true'::jsonb`);
    return rows[0] ? null : "Enable S3 storage (Settings › S3) before writing backups to it.";
  },
  // Security.md §2.7: the columns a stranger's registration form may write - the project's own columns of
  // users, never TotalBase's (the account's identity and security state) nor a Password column (its hashing is
  // the write paths', not a registration's).
  "auth.registration_columns": async (client, value) => {
    const columns = value as string[];
    if (columns.length === 0) return null;
    const { rows } = await client.query<{ name: string; password: boolean }>(
      `SELECT a.attname AS name,
              EXISTS (SELECT 1 FROM totalbase.resources_columns rc JOIN totalbase.resources r ON r.id = rc.resource
                       WHERE r."schema" = 'totalbase' AND r.name = 'users' AND rc.attnum = a.attnum AND rc.config ->> 'input' = 'password') AS password
         FROM pg_attribute a
        WHERE a.attrelid = 'totalbase.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY($1::text[])`,
      [columns],
    );
    for (const column of columns) {
      const row = rows.find((r) => r.name === column);
      if (!row) return `${column} is not a column of the users table.`;
      if (!isProjectUserColumn(column)) return `${column} is TotalBase's own column - a registration sets the project's columns only.`;
      if (row.password) return `${column} is a Password column - never set on registration.`;
    }
    return null;
  },
  // Security.md §2.21: roles that exist, and none of the reserved ones - Administrators always gets in, and
  // Public is everyone, which would be no lockdown.
  "lockdown.allowed_roles": async (client, value) => {
    const ids = value as string[];
    if (ids.length === 0) return null;
    const { rows } = await client.query<{ id: string; reserved: boolean }>(`SELECT id, reserved FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [ids]);
    if (rows.length !== ids.length) return "No role with one of those ids.";
    return rows.some((role) => role.reserved) ? "A reserved role can't be listed here." : null;
  },
  // Security.md §2.17: roles that exist - Administrators among them; never Workflows, whose one account never signs in.
  "mfa.required_roles": async (client, value) => {
    const ids = value as string[];
    if (ids.length === 0) return null;
    const { rows } = await client.query<{ id: string; name: string; reserved: boolean }>(`SELECT id, name, reserved FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [ids]);
    if (rows.length !== ids.length) return "No role with one of those ids.";
    return rows.some((role) => role.reserved && role.name !== "Administrators") ? "Of the reserved roles, only Administrators can be listed here." : null;
  },
  // Security.md §2.7: a role a self-registered account may
  // be given - never one that grants administration.
  "auth.registration_default_role": async (client, value) => {
    if (value === "") return null;
    const { rows } = await client.query<{ reserved: boolean; admin_access: boolean }>(
      `SELECT reserved, admin_access FROM totalbase.roles WHERE id = $1`,
      [value],
    );
    if (!rows[0]) return "No role with that id.";
    if (rows[0].reserved || rows[0].admin_access) {
      return "A reserved role or a role with admin access can't be given on self-registration.";
    }
    return null;
  },
};

/** A UUID - a role's id - as PostgreSQL writes it: lower case. */
const lowerUuid = (value: unknown): unknown => (typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : value);

/**
 * What a value is stored as, before it is validated: role ids in lower case, as PostgreSQL returns them - code
 * compares them as strings (`includes`), so an id written in upper case would match no role and cover no one
 * (SEC-115).
 */
const SETTINGS_NORMALIZERS: Partial<Record<SettingKey, (value: unknown) => unknown>> = {
  "mfa.required_roles": (value) => (Array.isArray(value) ? value.map(lowerUuid) : value),
  "lockdown.allowed_roles": (value) => (Array.isArray(value) ? value.map(lowerUuid) : value),
  "auth.registration_default_role": lowerUuid,
};

function normalize(key: SettingKey, value: unknown): unknown {
  return SETTINGS_NORMALIZERS[key]?.(value) ?? value;
}

async function validateInDatabase(client: Queryable, key: SettingKey, value: unknown): Promise<void> {
  const problem = await SETTINGS_DATABASE_VALIDATORS[key]?.(client, value);
  if (problem) throw new TotalBaseError("INVALID_SETTING", `${key}: ${problem}`);
}

/**
 * Every write must match its key's registry type - the default value's
 * shape is the type (numbers whole and within SETTINGS_BOUNDS, arrays of
 * strings, objects not arrays), so an Admin API caller can't store "20"
 * where code reads a number, or -1 as a page size. Structured values
 * (URLs, templates) get SETTINGS_VALIDATORS on top of this.
 */
function validate(key: SettingKey, value: unknown): void {
  const problem = typeProblem(key, value) ?? SETTINGS_VALIDATORS[key]?.(value);
  if (problem) throw new TotalBaseError("INVALID_SETTING", `${key}: ${problem}`);
}

/**
 * Stores a validated value - or, when it equals the registry default,
 * drops the override instead: the table only ever holds values that
 * actually differ, so "Modified" in the admin and a future change of a
 * default both mean what they say.
 */
async function write(client: Queryable, key: SettingKey, value: unknown, fallback: unknown): Promise<void> {
  if (JSON.stringify(value) === JSON.stringify(fallback)) {
    await client.query(`DELETE FROM totalbase.settings WHERE key = $1`, [key]);
    return;
  }
  await client.query(
    `INSERT INTO totalbase.settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

function typeProblem(key: SettingKey, value: unknown): string | null {
  const fallback = SETTINGS_DEFAULTS[key] as unknown;
  if (typeof fallback === "number") {
    const { min, max } = settingBounds(key);
    const range = max === undefined ? `${min} or more` : `from ${min} to ${max}`;
    return typeof value === "number" && Number.isInteger(value) && value >= min && (max === undefined || value <= max)
      ? null
      : `Expected a whole number ${range}.`;
  }
  if (typeof fallback === "boolean") return typeof value === "boolean" ? null : "Expected true or false.";
  if (typeof fallback === "string") return typeof value === "string" ? null : "Expected text.";
  if (Array.isArray(fallback)) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? null : "Expected a list of text values.";
  }
  if (typeof fallback === "object" && fallback !== null) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? null : "Expected an object.";
  }
  return null;
}

/**
 * Reads/writes typed setting overrides in totalbase.settings.
 * See Administration.md §7.1.
 *
 * `get` is called on essentially every request path (Data API limits,
 * idempotency, audit, ...), so reads are cached in-process indefinitely
 * and invalidated on `set`/`setGroup`. A write anywhere else - another
 * server process, the SQL Console - reaches `forget()` through the
 * SETTINGS signal a trigger on totalbase.settings sends at commit
 * (Foundations.md §4.6, apps/server's invalidations.ts).
 *
 * The cache fills as a whole: the first miss loads every stored override
 * in one statement and caches every registry key (its override or its
 * default), so a cold `getAll()` is one query, not one per key. A write
 * drops the key from the cache after it commits (`set` on the pool) or
 * while the caller's transaction is still open (`set` given a client) -
 * either way the next read goes to the database, and a read racing an
 * uncommitted write can't pin a pre-commit value: `load()` reads
 * committed rows only, and a key dropped after a write is loaded again.
 */
export class SettingsService {
  private readonly cache = new Map<SettingKey, unknown>();
  private loading: Promise<void> | null = null;
  /** Keys a write invalidated while a load was in flight - the load's rows may predate the write, so they stay out. */
  private droppedDuringLoad: Set<SettingKey> | null = null;

  /**
   * `dataDir`: the instance's data directory (TOTALBASE_DATA_DIR). Where it is known, the storage paths
   * (`files.storage_local_path`, `backups.local_path`) are confined to a directory strictly inside it, apart from each
   * other (assertStoragePath) - never the directory itself, which holds the master key.
   */
  constructor(private readonly database: Database, private readonly options: { dataDir?: string } = {}) {}

  /**
   * A key's default on this instance: the registry's, except the storage paths, which follow the data directory where
   * it is known - `<data dir>/files` and `<data dir>/backups` - so an instance started with its own TOTALBASE_DATA_DIR
   * keeps its files and backups there, inside it as assertStoragePath requires (`/var/lib/totalbase/...` otherwise).
   */
  defaultOf<K extends SettingKey>(key: K): SettingsRegistry[K] {
    if (this.options.dataDir && (key === "files.storage_local_path" || key === "backups.local_path")) {
      return join(resolvePath(this.options.dataDir), key === "backups.local_path" ? "backups" : "files") as SettingsRegistry[K];
    }
    return SETTINGS_DEFAULTS[key];
  }

  async get<K extends SettingKey>(key: K): Promise<SettingsRegistry[K]> {
    // A load leaves out a key written while it ran; the second load, after that write, has it.
    while (!this.cache.has(key)) await this.load();
    return this.cache.get(key) as SettingsRegistry[K];
  }

  /**
   * One `SELECT key, value` over every stored override, then every registry
   * key cached - a key missing from the table is its default. Concurrent
   * misses share one load. A key a write invalidates while the load runs
   * is left out of its result (the rows may predate the write), so the
   * next read of it loads again.
   */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    const dropped = new Set<SettingKey>();
    this.droppedDuringLoad = dropped;
    this.loading = this.database
      .query<{ key: string; value: unknown }>(`SELECT key, value FROM totalbase.settings`)
      .then(({ rows }) => {
        const overrides = new Map(rows.map((row) => [row.key, row.value]));
        for (const key of Object.keys(SETTINGS_DEFAULTS) as SettingKey[]) {
          if (!dropped.has(key)) this.cache.set(key, overrides.has(key) ? overrides.get(key) : this.defaultOf(key));
        }
      })
      .finally(() => {
        this.loading = null;
        this.droppedDuringLoad = null;
      });
    return this.loading;
  }

  /** Forgets a key: the next read loads it from the database (after a write - committed, or still in the caller's transaction). */
  private invalidate(key: SettingKey): void {
    this.cache.delete(key);
    this.droppedDuringLoad?.add(key);
  }

  /**
   * Another process (or the SQL Console) changed `key` - every key when none is given or it isn't in the
   * registry: the next read loads it again (Foundations.md §4.6, the SETTINGS signal).
   */
  forget(key?: string): void {
    if (key !== undefined && key in SETTINGS_DEFAULTS) {
      this.invalidate(key as SettingKey);
      return;
    }
    for (const known of Object.keys(SETTINGS_DEFAULTS) as SettingKey[]) this.invalidate(known);
  }

  async set<K extends SettingKey>(
    key: K,
    value: SettingsRegistry[K],
    client: Queryable = this.database,
  ): Promise<void> {
    value = normalize(key, value) as SettingsRegistry[K];
    validate(key, value);
    if (key === "files.storage_local_path" || key === "backups.local_path") await this.assertStoragePath(key, value as string);
    await validateInDatabase(client, key, value);
    await write(client, key, value, this.defaultOf(key));
    // Invalidated rather than written optimistically: `client` may be a
    // transaction that hasn't committed yet, so the next `get()` re-reads
    // from the database instead of caching a value that could still roll back.
    this.invalidate(key);
  }

  /**
   * A storage path is somewhere TotalBase writes and backs up: a directory strictly inside the data directory, and
   * neither inside the other storage path nor holding it. Without it, a path set to the data directory (or `/`, `/etc`)
   * put the master key and any server file into a backup's `files.tar`, readable by whoever downloads it.
   */
  private async assertStoragePath(key: "files.storage_local_path" | "backups.local_path", value: string): Promise<void> {
    if (!this.options.dataDir) return;
    const root = resolvePath(this.options.dataDir);
    const path = resolvePath(value);
    const inside = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
    if (!inside(path, root)) {
      throw new TotalBaseError("INVALID_SETTING", `${key}: Expected a directory inside the data directory (${root}), e.g. ${join(root, key === "backups.local_path" ? "backups" : "files")}.`);
    }
    const other = resolvePath(await this.get(key === "backups.local_path" ? "files.storage_local_path" : "backups.local_path"));
    if (path === other || inside(path, other) || inside(other, path)) {
      throw new TotalBaseError("INVALID_SETTING", `${key}: The files and the backups need directories of their own, neither inside the other.`);
    }
  }

  /**
   * A storage path as stored, checked again as a write checks it: an override written before the check existed, or
   * straight into totalbase.settings, never makes a backup take the data directory (or `/etc`) with it.
   */
  async confinedStoragePath(key: "files.storage_local_path" | "backups.local_path"): Promise<string> {
    const value = await this.get(key);
    await this.assertStoragePath(key, value);
    return value;
  }

  /** Drops a stored override, so the key reads its registry default again. */
  async reset(key: SettingKey, client: Queryable = this.database): Promise<void> {
    // The default goes through the same database checks: resetting s3.enabled turns it off.
    await validateInDatabase(client, key, this.defaultOf(key));
    await client.query(`DELETE FROM totalbase.settings WHERE key = $1`, [key]);
    this.invalidate(key);
  }

  /** Whether an override is stored for the key (false = it reads its registry default). */
  async isOverridden(key: SettingKey): Promise<boolean> {
    const { rows } = await this.database.query(`SELECT 1 FROM totalbase.settings WHERE key = $1`, [key]);
    return rows.length > 0;
  }

  /** All registered setting keys, defaults merged with any stored override (Administration.md §7.2: "GET /settings"). */
  async getAll(): Promise<Record<SettingKey, unknown>> {
    const keys = Object.keys(SETTINGS_DEFAULTS) as SettingKey[];
    // One load when any key is missing (a cold cache, or keys dropped by writes) - never a query per key.
    while (!keys.every((key) => this.cache.has(key))) await this.load();
    return Object.fromEntries(keys.map((key) => [key, this.cache.get(key)])) as Record<SettingKey, unknown>;
  }

  /** Keys belonging to one dotted group, e.g. "audit" -> "audit.enabled", "audit.retention_days", ... */
  async getGroup(group: string): Promise<Record<string, unknown>> {
    const all = await this.getAll();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(`${group}.`)) result[key] = value;
    }
    return result;
  }

  /**
   * Applies a partial patch to one group. Keys may be given either fully
   * dotted ("audit.enabled") or bare ("enabled") - both resolve against
   * the same group. Unknown keys are rejected rather than silently
   * stored (Administration.md §7.1: registry definitions live in code).
   *
   * All or nothing: every key is checked before anything is written, and
   * the writes share one transaction - a patch with one bad value leaves
   * the group exactly as it was.
   */
  async setGroup(group: string, patch: Record<string, unknown>): Promise<void> {
    const validKeys = new Set(Object.keys(SETTINGS_DEFAULTS));
    const entries = Object.entries(patch).map(([rawKey, value]) => {
      // Bare keys may contain dots of their own ("links.invitation" in the
      // auth group), so only a key that already starts with the group is
      // taken as fully dotted.
      const fullKey = rawKey.startsWith(`${group}.`) ? rawKey : `${group}.${rawKey}`;
      if (!fullKey.startsWith(`${group}.`) || !validKeys.has(fullKey)) {
        throw new TotalBaseError("INVALID_SETTING", `Unknown setting key for group "${group}": ${rawKey}`);
      }
      const normalized = normalize(fullKey as SettingKey, value);
      validate(fullKey as SettingKey, normalized);
      return [fullKey as SettingKey, normalized] as const;
    });
    // A lockdown scheduled once is its two ends together (Security.md §2.21): checked as it will be once this
    // patch is in, and only when the patch changes it - a window that has passed stays as it is, saved again
    // with its page. Turned on as "scheduled once", it has them.
    const patched = new Map<SettingKey, unknown>(entries);
    // The same confinement as set(): the settings page writes these keys here.
    for (const [key, value] of entries) {
      if (key === "files.storage_local_path" || key === "backups.local_path") await this.assertStoragePath(key, value as string);
    }
    if (["lockdown.enabled", "lockdown.when", "lockdown.from", "lockdown.until"].some((key) => patched.has(key as SettingKey))) {
      const [enabled, when, from, until] = await Promise.all([this.get("lockdown.enabled"), this.get("lockdown.when"), this.get("lockdown.from"), this.get("lockdown.until")]);
      const nextFrom = (patched.get("lockdown.from") as string | undefined) ?? from;
      const nextUntil = (patched.get("lockdown.until") as string | undefined) ?? until;
      const once = ((patched.get("lockdown.enabled") as boolean | undefined) ?? enabled) && ((patched.get("lockdown.when") as string | undefined) ?? when) === "ONCE";
      const problem =
        once && (nextFrom === "" || nextUntil === "")
          ? "A lockdown scheduled once needs both its start and its end."
          : nextFrom === from && nextUntil === until
            ? null
            : lockdownWindowProblem(nextFrom, nextUntil, Date.now());
      if (problem) throw new TotalBaseError("INVALID_SETTING", `lockdown.until: ${problem}`);
    }
    try {
      await this.database.transaction(async (client) => {
        for (const [key, value] of entries) await validateInDatabase(client, key, value);
        for (const [key, value] of entries) await write(client, key, value, this.defaultOf(key));
      });
    } finally {
      // After commit (or rollback): a get() racing the transaction can't
      // leave a pre-commit value cached.
      for (const [key] of entries) this.invalidate(key);
    }
  }
}
