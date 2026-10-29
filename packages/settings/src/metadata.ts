import { REGIONAL_FORMATS, regionalFormatLabel, UI_LANGUAGES } from "@totalbase/shared";
import type { SettingKey } from "./registry.js";

/**
 * Human-facing copy for the Settings UI (admin's /settings/* pages) -
 * label/description/unit per key, plus a label/description per group.
 * Deliberately partial (AGENTS.md section 3): only groups that actually
 * have a settings page in the admin are covered here. A key missing from
 * SETTINGS_METADATA still works - GET .../settings/:group/schema falls
 * back to the key's own name, and the admin renders that instead of
 * failing - so adding a new registry key never breaks this file, it
 * just reads a little less polished until someone writes its copy.
 *
 * Layout intent (not enforced here, just what the admin renders this
 * into): a subtitle + a one-line "what this does" description per
 * setting, control below it - boolean settings save on toggle, anything
 * else needs an explicit Save/Reset pair. See SettingsGroupForm.vue.
 */
/**
 * Where else the person goes to make a setting work: another setting (its
 * page, scrolled to it) or an admin page. A `secret` input links Secrets
 * and a `role` input Roles by itself - list only what the copy can't say.
 */
export type SettingLink = { setting: SettingKey } | { page: SettingLinkPage };
export type SettingLinkPage = "secrets" | "roles" | "templates" | "docs" | "s3";

export interface SettingMetadata {
  label: string;
  description: string;
  /** Short suffix shown next to a number input, e.g. "days", "ms", "bytes". */
  unit?: string;
  /** Subheading the setting is listed under on its page; a group whose keys have none renders as one flat list. */
  section?: string;
  /**
   * Widget, when the value's own type isn't enough: `secret` picks a key
   * from Settings > Secrets, `timezone` an IANA zone, `json` a code
   * textarea, `textarea` plain text on several lines, `role` a role (by id) a user can be given - neither reserved
   * nor with admin access, `cron` a cron expression with its next
   * occurrences (in the instance's timezone). Omitted = inferred from the value (switch,
   * number, tags, text).
   */
  input?: "secret" | "timezone" | "regional" | "json" | "role" | "image" | "color" | "css" | "cards" | "textarea" | "cron";
  /** Fixed choices for a text setting - rendered as a select, or as option cards (`input: "cards"`) when each has a description. */
  options?: Array<{ label: string; value: string; description?: string }>;
  /** Option cards one under the other - for choices whose descriptions need the width. Unset: side by side. */
  orientation?: "vertical";
  /** A boolean setting that switches this one off - the admin locks it while that one is off (Admin_UI.md §11). */
  dependsOn?: SettingKey;
  /**
   * The switch that turns its page's whole feature on (MCP, Files, GraphQL...): shown on its own above
   * everything else on the page, which waits for it. One per page, only where the switch turns the feature off.
   */
  primary?: boolean;
  /** Shown under the description as links. */
  links?: SettingLink[];
}

export const SETTINGS_GROUP_METADATA: Record<string, { label: string; description: string }> = {
  api: {
    label: "Limits",
    description: "Limits and defaults applied to every request through TotalBase's generic table API.",
  },
  appearance: {
    label: "Appearance",
    description: "How this instance looks to everyone - its color, its sign-in page and any CSS of your own. Public: all of it reaches the browser before sign-in.",
  },
  query: {
    label: "Query features",
    description: "Query language features Data API callers may use.",
  },
  api_keys: {
    label: "Tokens",
    description: "Defaults applied when a personal API token is issued without its own explicit values.",
  },
  files: {
    label: "Files",
    description: "Upload limits and on-the-fly image transformation settings for the Files explorer.",
  },
  audit: {
    label: "Audit",
    description: "What gets recorded to the audit log, and for how long it's kept.",
  },
  system: {
    label: "General",
    description: "This instance's name and logo, public address, and how it shows dates and times.",
  },
  auth: {
    label: "Authentication",
    description: "Account registration, session lifetime, and password policy for TotalBase users.",
  },
  smtp: {
    label: "SMTP",
    description: "The mail relay for system emails and Workflow \"Send email\" steps.",
  },
  backups: {
    label: "Backups",
    description: "Scheduled backups of the database and the stored files, kept on the local disk or in S3 storage. The master key is never in them - keep it apart.",
  },
  s3: {
    label: "S3 storage",
    description: "A connection to an S3-compatible bucket - Amazon S3, Cloudflare R2, MinIO and others - where Files can store uploads.",
  },
  security: {
    label: "Network",
    description: "Rate limiting, CORS, and reverse-proxy trust settings for the public API.",
  },
  pool: {
    label: "Connection pool",
    description: "The PostgreSQL connections TotalBase keeps open. Applies after a server restart.",
  },
  catalog: {
    label: "Schema sync",
    description: "How TotalBase keeps its resources in step with your PostgreSQL schema.",
  },
  openapi: {
    label: "OpenAPI",
    description: "The Data API document generated from your schema, permissions and workflows.",
  },
  mcp: {
    label: "MCP",
    description: "The MCP server an AI agent builds and operates this instance through - served at this instance's own address, /mcp, with an administrator's token.",
  },
  realtime: {
    label: "Realtime",
    description: "Realtime subscriptions: clients follow the changes of the tables exposing Realtime over one WebSocket, /api/realtime, receiving only what their READ permission allows.",
  },
  graphql: {
    label: "GraphQL",
    description: "The GraphQL API: the Data API's tables at /api/graphql, each caller seeing only what their roles allow.",
  },
  sql_console: {
    label: "SQL Console",
    description: "Whether admins can run raw SQL, how much of a result it shows, and how long its history is kept.",
  },
  dataviews: {
    label: "DataViews",
    description: "The toolbar every list DataView opens with, how wide its pages grow, and row caps for exporting, printing and the MAP, KANBAN, CALENDAR and GANTT layouts.",
  },
  maps: {
    label: "Maps",
    description: "The tiles every map draws - MAP DataViews, map fields and dashboard maps.",
  },
  workflows: {
    label: "Workflows",
    description: "Execution limits and history retention for the Workflows engine.",
  },
  dashboards: {
    label: "Dashboards",
    description: "Limits on the read-only SQL queries behind dashboard widgets, and embedding dashboards in other sites.",
  },
  app: {
    label: "App",
    description: "How the App shows its menu of published DataViews and Dashboards.",
  },
  transactions: {
    label: "Transactions",
    description: "Several Data API operations committed or rolled back as one PostgreSQL transaction.",
  },
  idempotency: {
    label: "Idempotency",
    description: "Idempotency-Key replay, so a retried write runs only once.",
  },
  async_executions: {
    label: "Executions",
    description: "The PostgreSQL-backed queue that runs executions in the background, with retries.",
  },
  outbox: {
    label: "Data events",
    description: "The outbox of committed data changes that starts DATA_EVENT workflows: retries and retention.",
  },
};

export const SETTINGS_METADATA: Partial<Record<SettingKey, SettingMetadata>> = {
  // --- api.* ---
  "api.default_limit": {
    label: "Default page size",
    description: "Rows returned by a list request that doesn't specify its own limit.",
    section: "Pagination",
  },
  "api.max_limit": {
    label: "Maximum page size",
    description: "The largest limit a caller is allowed to request, regardless of what they ask for.",
    section: "Pagination",
  },
  "api.max_offset": {
    label: "Maximum offset",
    description: "Caps how deep offset-based pagination can page into a result set.",
    section: "Pagination",
  },
  "api.max_relation_depth": {
    label: "Maximum relation depth",
    description: "How many foreign keys a dotted path may follow in one request (order.customer.email follows two).",
    section: "Query complexity",
  },
  "api.max_filter_depth": {
    label: "Maximum filter depth",
    description: "How deeply nested a filter expression (and/or groups) is allowed to be.",
    section: "Query complexity",
  },
  "api.require_where_for_update": {
    label: "Require a filter for bulk update",
    description: "Blocks a bulk UPDATE that has no WHERE clause - through the Data API or a workflow's Update records step - to prevent accidentally updating every row.",
    section: "Writes",
  },
  "api.require_where_for_delete": {
    label: "Require a filter for bulk delete",
    description: "Blocks a bulk DELETE that has no WHERE clause - through the Data API or a workflow's Delete records step - to prevent accidentally deleting every row.",
    section: "Writes",
  },
  "api.bulk_max_items": {
    label: "Maximum bulk items",
    description: "The most rows a single bulk create/update/delete request can touch at once.",
    section: "Writes",
  },
  "api.max_body_bytes": {
    label: "Maximum request body size",
    description: "Requests with a larger body are rejected before they're parsed.",
    unit: "bytes",
    section: "Requests",
  },
  "api.max_query_string_bytes": {
    label: "Maximum query string size",
    description: "Requests with a longer query string are rejected before they're parsed. Raising it above the value the server started with takes a restart.",
    unit: "bytes",
    section: "Requests",
  },
  "api.max_query_parameters": {
    label: "Maximum query parameters",
    description: "The most query-string parameters a single request is allowed to send.",
    section: "Requests",
  },
  "api.max_query_nodes": {
    label: "Maximum query nodes",
    description: "Caps the total complexity (filter/sort/expand nodes combined) of a single request.",
    section: "Query complexity",
  },
  "api.nested_write_max_depth": {
    label: "Maximum nested write depth",
    description: "How many levels deep a single CREATE can nest child records (parent → child → grandchild).",
    section: "Writes",
  },
  "api.nested_write_max_records": {
    label: "Maximum nested write records",
    description: "The most records a single nested create can insert across all levels combined.",
    section: "Writes",
  },

  "api.request_timeout_ms": {
    label: "Request timeout",
    description: "Longest a single Data API request's SQL may run - PostgreSQL cancels it past this and the caller gets QUERY_CANCELED.",
    unit: "ms",
    section: "Requests",
  },
  "api.allow_count": {
    label: "Allow count",
    description: "Lets a list request ask for the total number of matching rows (count=true) - an extra query over the whole filtered set.",
    section: "Query features",
  },
  "query.allow_regex": {
    label: "Allow regular expressions",
    description: "Lets filters use _regex. A regular expression can't use an ordinary index, so it scans every row it's applied to.",
    section: "Query features",
  },
  "query.allow_contains": {
    label: "Allow containment operators",
    description: "Lets filters use _contains, _contained_by and _overlap on arrays and jsonb - fast with a GIN index, a full scan without one.",
    section: "Query features",
  },
  "query.allow_having": {
    label: "Allow having",
    description: "Lets grouped queries filter on their aggregates (having), after grouping every matching row.",
    section: "Query features",
  },

  // --- api_keys.* ---
  "api_keys.default_ttl_days": {
    label: "Default expiry",
    description: "How long a newly issued API key is valid for, if the request doesn't set its own expiry.",
    unit: "days",
  },
  "api_keys.rotation_warning_days": {
    label: "Rotation warning window",
    description: "How far ahead of expiry an API key is flagged as \"expiring soon\" in the admin.",
    unit: "days",
  },
  "api_keys.purge_after_days": {
    label: "Keep ended tokens",
    description: "Revoked and expired tokens stay listed for this long after they end, then are deleted. A deactivated token is kept - it can be turned on again. 0 keeps them forever.",
    unit: "days",
  },

  // --- files.* ---
  "files.enabled": {
    label: "Enable Files",
    description: "Turns the Files explorer upload and storage feature on or off.",
    primary: true,
  },
  "files.max_file_size_bytes": {
    label: "Maximum file size",
    description: "The largest single file an upload is allowed to be.",
    unit: "bytes",
    section: "Uploads",
    dependsOn: "files.enabled",
  },
  "files.allowed_mime_types": {
    label: "Allowed file types",
    description: "MIME types accepted on upload. Wildcards such as text/* and image/* are supported.",
    section: "Uploads",
    dependsOn: "files.enabled",
  },
  "files.default_visibility_public": {
    label: "Public by default",
    description: "Whether a newly uploaded file starts as public when the upload form does not choose otherwise.",
    section: "Uploads",
    dependsOn: "files.enabled",
  },
  "files.storage_provider": {
    label: "Storage provider",
    description: "Where new uploads are stored. A file already uploaded stays where it was written and is still served from there. S3 storage must be enabled first.",
    section: "Storage",
    options: [{ label: "Local disk", value: "local" }, { label: "S3 storage", value: "s3" }],
    links: [{ page: "s3" }],
  },
  "files.storage_local_path": {
    label: "Local storage path",
    description: "Where local files are kept - including those uploaded before switching to S3 storage, still served from here.",
    section: "Storage",
  },
  "files.transforms.enabled": {
    label: "Enable image transforms",
    description: "Turns on-the-fly image resizing/format conversion on or off.",
    section: "Image transformations",
  },
  "files.transforms.max_width": {
    label: "Maximum output width",
    description: "The widest an on-the-fly transformed image is allowed to be.",
    unit: "px",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.max_height": {
    label: "Maximum output height",
    description: "The tallest an on-the-fly transformed image is allowed to be.",
    unit: "px",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.max_pixels": {
    label: "Maximum total pixels",
    description: "Caps width × height together, on top of the individual width/height limits.",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.max_concurrent": {
    label: "Maximum concurrent transforms",
    description: "How many image transforms are allowed to run at the same time.",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.timeout_ms": {
    label: "Transform timeout",
    description: "A transform that takes longer than this is aborted.",
    unit: "ms",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.cache_ttl_seconds": {
    label: "Transform cache lifetime",
    description: "How long browsers may cache a transformed image, and how long its stored copy is kept before the hourly cleanup removes it (the next request regenerates it).",
    unit: "seconds",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.max_operations": {
    label: "Maximum operations per transform",
    description: "The most chained operations (resize, crop, format, ...) a single transform request can request.",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
  },
  "files.transforms.presets_json": {
    label: "Named presets (JSON)",
    description: "A raw JSON object of named transform presets, e.g. {\"thumbnail\":{\"width\":150,\"height\":150,\"fit\":\"cover\",\"format\":\"webp\",\"quality\":80}}.",
    section: "Image transformations",
    dependsOn: "files.transforms.enabled",
    input: "json",
  },

  // --- audit.* ---
  "audit.enabled": {
    label: "Enable audit logging",
    description: "Turns audit logging on or off for the whole system.",
    primary: true,
  },
  "audit.retention_days": {
    label: "Retention period",
    description: "Audit log entries older than this are purged automatically, hourly. 0 keeps them forever.",
    unit: "days",
  },
  "audit.store_sql": {
    label: "Store SQL statements",
    description: "Whether the audit log keeps the actual SQL statement executed for each write.",
    dependsOn: "audit.enabled",
  },
  "audit.store_sql_params": {
    label: "Store SQL parameters",
    description: "Whether the audit log also keeps the bound parameter values, not just the statement shape.",
    dependsOn: "audit.store_sql",
  },

  // --- auth.* ---
  "auth.registration_enabled": {
    label: "Allow self-registration",
    description: "Lets a new user create their own account instead of requiring an admin invitation.",
    section: "Accounts & sessions",
  },
  "auth.registration_default_role": {
    label: "Default role for self-registration",
    description: "Given to every account created through self-registration. None: a new account has no roles until someone assigns one.",
    section: "Accounts & sessions",
    input: "role",
    dependsOn: "auth.registration_enabled",
  },
  "auth.email_verification_required": {
    label: "Require email verification",
    description: "A newly registered account can't sign in until its email address is verified.",
    section: "Accounts & sessions",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },
  "auth.password_min_length": {
    label: "Minimum password length",
    description: "The shortest password TotalBase will accept when a user sets or changes theirs.",
    section: "Accounts & sessions",
  },
  "auth.session_ttl_hours": {
    label: "Session lifetime",
    description: "How long a signed-in session stays valid before it needs to sign in again.",
    unit: "hours",
    section: "Accounts & sessions",
  },
  "auth.session_idle_minutes": {
    label: "Sign out after inactivity",
    description: "A session unused this long ends, and its user signs in again - for shared or unattended computers. 0 keeps a session until its lifetime ends.",
    unit: "minutes",
    section: "Accounts & sessions",
  },
  "auth.password_reset_ttl_minutes": {
    label: "Password reset link lifetime",
    description: "How long a \"reset your password\" link stays valid after it's sent.",
    unit: "minutes",
    section: "Accounts & sessions",
  },
  "auth.email_verification_ttl_hours": {
    label: "Email verification link lifetime",
    description: "How long a \"verify your email\" link stays valid after it's sent.",
    unit: "hours",
    section: "Accounts & sessions",
  },
  "auth.invitation_ttl_hours": {
    label: "Invitation lifetime",
    description: "How long an admin-sent invitation link stays valid before it expires.",
    unit: "hours",
    section: "Accounts & sessions",
  },
  "auth.max_sessions_per_user": {
    label: "Maximum sessions per user",
    description: "The most devices/browsers a single user can be signed in on at once.",
    section: "Accounts & sessions",
  },
  "auth.session_retention_days": {
    label: "Keep ended sessions",
    description: "Revoked and expired sessions stay listed (Sessions → Revoked / Expired) for this long after they end, then are deleted. 0 keeps them forever.",
    unit: "days",
    section: "Accounts & sessions",
  },
  "auth.lockout_max_attempts": {
    label: "Lock after failed sign-ins",
    description: "Consecutive wrong passwords that lock the account for a while. The person sees the usual \"invalid email or password\" either way; an admin can unlock them early. 0 turns lockout off.",
    unit: "attempts",
    section: "Sign-in protection",
  },
  "auth.dormant_account_days": {
    label: "Deactivate unused accounts",
    description: "An account with no sign-in, no session and no token used for this many days is deactivated - someone who left, an account nobody remembered. The owner never is. 0 turns it off.",
    unit: "days",
    section: "Accounts & sessions",
  },
  "auth.reauthentication_minutes": {
    label: "Confirm identity for sensitive actions",
    description: "How long after signing in, or confirming their password again, an administrator can issue an administrator token, assign Administrators, or change another account's email, password or two-factor authentication. Past it, they're asked for their password (or a code) first.",
    unit: "minutes",
    section: "Sign-in protection",
  },
  "auth.lockout_duration_minutes": {
    label: "Lockout duration",
    description: "How long a locked account stays locked. A password reset or an admin's unlock ends it sooner.",
    unit: "minutes",
    section: "Sign-in protection",
  },
  "auth.mfa_required": {
    label: "Require two-factor authentication",
    description: "Who must sign in with a code from an authenticator app. Someone required who hasn't set it up is asked to at their next sign-in; sessions already open stay.",
    section: "Sign-in protection",
    options: [
      { label: "No one", value: "NONE" },
      { label: "Administrators", value: "ADMINISTRATORS" },
      { label: "Everyone", value: "EVERYONE" },
    ],
  },
  "auth.links.invitation": {
    label: "Invitation link",
    description: "Where an invitation email's link points. {{public_url}} and {{token}} are filled in by TotalBase - point it at your own app's page if it handles invitations itself.",
    section: "Email links",
  },
  "auth.links.password_reset": {
    label: "Password reset link",
    description: "Where a password reset email's link points. Same {{public_url}} and {{token}} placeholders.",
    section: "Email links",
  },
  "auth.links.email_verification": {
    label: "Email verification link",
    description: "Where an email verification link points. Same {{public_url}} and {{token}} placeholders.",
    section: "Email links",
  },
  "auth.password_changed_email_enabled": {
    label: "Password changed notice",
    description: "Email the account owner whenever their password is changed or reset - a security notice.",
    section: "Notices",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },
  "auth.email_changed_email_enabled": {
    label: "Email changed notice",
    description: "Email the previous address whenever an admin changes a user's email - a security notice.",
    section: "Notices",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },
  "auth.mfa_disabled_email_enabled": {
    label: "Two-factor turned off notice",
    description: "Email the account owner whenever their two-factor authentication is turned off, or reset by an admin - a security notice.",
    section: "Notices",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },
  "auth.token_created_email_enabled": {
    label: "New API token notice",
    description: "Email the account owner whenever an API token is created or regenerated for them - a security notice.",
    section: "Notices",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },
  "auth.welcome_email_enabled": {
    label: "Welcome email",
    description: "Email a welcome message once an invited or registered account is ready to use.",
    section: "Notices",
    links: [{ setting: "smtp.host" }, { page: "templates" }],
  },

  // --- system.* ---
  "system.public_url": {
    label: "Public URL",
    description: "The final address people reach this instance at, e.g. https://totalbase.example.com - invitation, password reset and OAuth links are built from it. Leave empty to use the TOTALBASE_PUBLIC_URL environment variable.",
    section: "Instance",
  },
  "system.instance_name": {
    label: "Instance name",
    description: "How this instance names itself - beside its mark, in the browser tab and in the emails it sends.",
    section: "Instance",
  },
  "system.logo": {
    label: "Logo",
    description: "Your mark in place of TotalBase's, beside the instance's name - in the rail, on the sign-in page and on the public pages - shown at the mark's height, so a wide or a square image both work. A public image in Files; PNG or SVG with transparency looks best.",
    section: "Instance",
    input: "image",
  },
  "system.language": {
    label: "Default language",
    description: "The language of the interface for users who didn't choose one in My account, and of pages with no signed-in user - sign-in, password reset, embedded dashboards. Data and PostgreSQL's messages are never translated.",
    options: UI_LANGUAGES.map((language) => ({ label: language.name, value: language.code })),
    section: "Language",
  },
  "system.regional_format": {
    label: "Regional format",
    description: "How numbers, dates and times read - separators, grouping, the order of day and month, 12 or 24 hours - for every user who didn't choose their own; a field's own Format still wins. The region, not the language: the interface in English can read 1.234,56. Browser = each viewer's regional settings.",
    input: "regional",
    options: [{ label: "Browser", value: "" }, ...REGIONAL_FORMATS.map((format) => ({ label: regionalFormatLabel(format, "en"), value: format }))],
    section: "Language",
  },
  "system.timezone": {
    label: "Timezone",
    description: "The organization's zone: timestamptz values are shown in it, and reports and filters such as \"this month\" count days in it - for every user who didn't choose their own. Empty = each viewer's browser timezone.",
    section: "Date & time",
    input: "timezone",
  },
  "system.timezone_user_choice": {
    label: "Users can choose their own timezone",
    description: "Off: everyone works in the Timezone above - a user's own choice is kept, not used, until this is on again. Needs a Timezone set: with none, each viewer's browser decides.",
    section: "Date & time",
    links: [{ setting: "system.timezone" }],
  },

  // --- smtp.* --- (system emails and the workflow Send email operation)
  "smtp.host": {
    label: "SMTP host",
    description: "Hostname of the outgoing mail relay. Empty means SMTP isn't configured - sending fails until this is set.",
  },
  "smtp.port": {
    label: "SMTP port",
    description: "Port to connect to on the SMTP host - typically 587 (STARTTLS) or 465 (implicit TLS).",
  },
  "smtp.secure": {
    label: "Use implicit TLS",
    description: "Connect over TLS from the start (port 465-style) instead of upgrading via STARTTLS.",
  },
  "smtp.username": {
    label: "SMTP username",
    description: "Username to authenticate with the SMTP relay. Leave empty for a relay that doesn't require auth.",
  },
  "smtp.password_secret_key": {
    label: "SMTP password (secret key)",
    description: "The key of a Settings → Secrets entry holding the SMTP password - never stored here in plaintext. Leave empty for a relay that doesn't require auth.",
    input: "secret",
  },
  "smtp.from": {
    label: "From address",
    description: "The envelope/header From address outgoing mail is sent as.",
  },
  "s3.enabled": {
    label: "Enable S3 storage",
    description: "Turns the connection on. Can't be turned off while Files stores new uploads in it or still holds files there.",
    primary: true,
  },
  "s3.endpoint": {
    label: "Endpoint",
    description: "The service's base URL, e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com or http://minio:9000.",
    dependsOn: "s3.enabled",
  },
  "s3.region": {
    label: "Region",
    description: "The bucket's region, part of every request's signature - us-east-1 for most services that don't have regions, auto for Cloudflare R2.",
    dependsOn: "s3.enabled",
  },
  "s3.bucket": {
    label: "Bucket",
    description: "The bucket to write to. It must exist; TotalBase doesn't create it.",
    dependsOn: "s3.enabled",
  },
  "s3.prefix": {
    label: "Key prefix",
    description: "A folder inside the bucket for this instance, e.g. production/ - so several instances can share one bucket. Each use writes under its own folder in it (files/). Empty: the bucket's root.",
    dependsOn: "s3.enabled",
  },
  "s3.path_style": {
    label: "Path-style addressing",
    description: "Address the bucket as endpoint/bucket instead of bucket.endpoint - MinIO and most self-hosted services need it on.",
    dependsOn: "s3.enabled",
  },
  "s3.access_key_id": {
    label: "Access key ID",
    description: "The access key's ID. Its secret goes in the next setting, as a secret.",
    dependsOn: "s3.enabled",
  },
  "s3.secret_key": {
    label: "Secret access key (secret key)",
    description: "The key of a Settings → Secrets entry holding the secret access key - never stored here in plaintext.",
    input: "secret",
    dependsOn: "s3.enabled",
  },

  // --- backups.* (Administration.md §12) ---
  "backups.enabled": {
    label: "Enable backups",
    description: "Backs the instance up on the schedule below, and lets an administrator Back up now. Off: no new backup - those made stay listed, to download or delete.",
    primary: true,
  },
  "backups.schedule": {
    label: "Schedule",
    description: "When, as a cron expression in the instance's timezone (Settings › General). 0 3 * * *: every day at 03:00.",
    section: "Schedule",
    input: "cron",
    dependsOn: "backups.enabled",
  },
  "backups.keep": {
    label: "Backups to keep",
    description: "The most recent completed backups kept; an older one is deleted after each new one completes.",
    section: "Schedule",
    dependsOn: "backups.enabled",
  },
  "backups.destination": {
    label: "Destination",
    description: "Where new backups are written. A backup already made stays where it was written.",
    section: "Destination",
    options: [{ label: "Local disk", value: "local" }, { label: "S3 storage", value: "s3" }],
    links: [{ page: "s3" }],
    dependsOn: "backups.enabled",
  },
  "backups.local_path": {
    label: "Local backups path",
    description: "The directory local backups are written to - mount a volume there, on another disk than the database's.",
    section: "Destination",
    dependsOn: "backups.enabled",
  },
  "backups.include_files": {
    label: "Include stored files",
    description: "The files Files keeps on the local disk go into each backup. Files kept in S3 storage never do - back the bucket up with the service's own versioning or replication.",
    section: "Content",
    dependsOn: "backups.enabled",
  },

  // --- security.* ---
  "security.rate_limit_enabled": {
    label: "Enable rate limiting",
    description: "Limits the requests and the failed sign-ins of each IP address. Behind a proxy, turn on Trust reverse proxy headers with it - otherwise every caller has the proxy's address and shares one limit.",
    section: "Rate limiting",
  },
  "security.rate_limit_per_minute": {
    label: "Requests per minute",
    description: "The most requests one IP address can make in a one-minute window before being throttled.",
    section: "Rate limiting",
    dependsOn: "security.rate_limit_enabled",
  },
  "security.rate_limit_sign_in_per_minute": {
    label: "Failed sign-ins per minute",
    description: "The most failed sign-in attempts from one IP address in a minute - a correct sign-in doesn't count. Each account also locks after its own failed attempts, in Access.",
    section: "Rate limiting",
    dependsOn: "security.rate_limit_enabled",
  },
  "security.cors_enabled": {
    label: "Enable CORS",
    description: "Allows browser requests to the API from the origins listed below.",
    section: "CORS",
  },
  "security.cors_origins": {
    label: "Allowed origins",
    description: "Origins (e.g. https://app.example.com) allowed to call the API directly from a browser.",
    section: "CORS",
    dependsOn: "security.cors_enabled",
  },
  "security.trust_proxy": {
    label: "Trust reverse proxy headers",
    description: "Reads the caller's real IP from X-Forwarded-For - only enable this behind a proxy you control. Applies after a restart.",
    section: "Reverse proxy",
  },
  "auth.access_review_interval_days": {
    label: "Access review interval",
    description: "How often the Administrators role's members should be reviewed - the role shows a review as due once its last one is older than this. 0 turns the reminder off.",
    unit: "days",
    section: "Access review",
  },

  // --- transactions.* ---
  "transactions.enabled": {
    label: "Enable transactions",
    description: "Allows POST /api/transactions - a role still needs its own transactions.execute grant to use it.",
    links: [{ page: "roles" }],
  },
  "transactions.max_operations": {
    label: "Maximum operations",
    description: "The most operations a single transaction request can contain.",
    dependsOn: "transactions.enabled",
  },
  "transactions.timeout_ms": {
    label: "Statement timeout",
    description: "How long one statement of a transaction may run before PostgreSQL cancels it (and the whole transaction rolls back). 0 uses the Data API's request timeout.",
    unit: "ms",
    dependsOn: "transactions.enabled",
  },

  // --- idempotency.* ---
  "idempotency.enabled": {
    label: "Enable idempotency keys",
    description: "Honors the Idempotency-Key header on writes - a retry with the same key replays the first response instead of running again.",
  },
  "idempotency.ttl_hours": {
    label: "Key lifetime",
    description: "How long a key and its stored response are kept - a retry after this runs as a new request.",
    unit: "hours",
    dependsOn: "idempotency.enabled",
  },
  "idempotency.max_response_bytes": {
    label: "Maximum stored response",
    description: "Larger responses aren't stored for replay - the write still runs only once, but a retry gets an error instead of the original body.",
    unit: "bytes",
    dependsOn: "idempotency.enabled",
  },

  // --- async_executions.* ---
  "async_executions.enabled": {
    label: "Enable the worker",
    description: "Turns off background processing - queued executions wait until it's enabled again.",
    primary: true,
  },
  "async_executions.max_retries": {
    label: "Maximum retries",
    description: "How many times a failed execution is retried, when its failure is retryable, before it's marked failed.",
    dependsOn: "async_executions.enabled",
  },
  "async_executions.retry_delay_seconds": {
    label: "Retry delay",
    description: "How long a failed execution waits before its next attempt.",
    unit: "seconds",
    dependsOn: "async_executions.enabled",
  },
  "async_executions.stale_timeout_ms": {
    label: "Stale timeout",
    description: "An execution still running after this is treated as abandoned by a crashed worker and picked up again.",
    unit: "ms",
    dependsOn: "async_executions.enabled",
  },
  "async_executions.poll_interval_ms": {
    label: "Poll interval",
    description: "How often the worker checks the queue for new work.",
    unit: "ms",
    dependsOn: "async_executions.enabled",
  },
  "async_executions.retention_days": {
    label: "Keep finished executions",
    description: "Completed, failed and cancelled executions stay queryable by their id for this long after they end, then are deleted. 0 keeps them forever.",
    unit: "days",
  },

  // --- outbox.* ---
  "outbox.retention_days": {
    label: "Processed event retention",
    description: "Data events already handed to their workflows are deleted after this long. Failed events that ran out of attempts are kept.",
    unit: "days",
    section: "Data events",
  },
  "outbox.max_attempts": {
    label: "Maximum attempts",
    description: "How many times a data event is dispatched before it stays failed.",
    section: "Data events",
  },
  "outbox.retry_delay_seconds": {
    label: "Retry delay",
    description: "The wait before a failed data event is retried - doubled after each further attempt.",
    unit: "seconds",
    section: "Data events",
  },
  "outbox.lease_seconds": {
    label: "Processing lease",
    description: "How long a data event being handed to its workflows is held before it counts as abandoned (its process stopped) and is retried. Keep it above the longest workflow run.",
    unit: "seconds",
    section: "Data events",
  },

  // --- pool.* ---
  "pool.max": {
    label: "Maximum connections",
    description: "The most connections open at once. Keep it under the database's max_connections, shared with every other client. Applies after a restart.",
    unit: "connections",
  },
  "pool.idle_timeout_ms": {
    label: "Idle timeout",
    description: "An unused connection is closed after this long. Applies after a restart.",
    unit: "ms",
  },
  "pool.connection_timeout_ms": {
    label: "Connection timeout",
    description: "How long a request waits for a free connection (or a new one to open) before failing. Applies after a restart.",
    unit: "ms",
  },
  "pool.max_lifetime_ms": {
    label: "Maximum connection lifetime",
    description: "A connection is replaced after this long, however busy - lets a load balancer or failover rebalance. 0 = never. Applies after a restart.",
    unit: "ms",
  },

  // --- catalog.* ---
  "catalog.watch_interval_seconds": {
    label: "Watch for schema changes",
    description: "How often TotalBase checks whether the schema changed outside it (psql, a migration tool), and syncs at once when it did. 0 = off.",
    unit: "seconds",
  },
  "catalog.refresh_interval_minutes": {
    label: "Scheduled sync",
    description: "How often TotalBase re-reads the whole schema, whatever the change check found - the safety net for what it can't see. 0 = off.",
    unit: "minutes",
  },
  "catalog.auto_refresh_after_ddl": {
    label: "Sync after SQL Console runs",
    description: "Re-reads the schema after every SQL Console run, so a table it creates or drops shows up at once. The table editor always syncs.",
  },
  "catalog.track_comments": {
    label: "Sync descriptions with COMMENT ON",
    description: "Fills a resource's empty description from PostgreSQL's COMMENT ON, and an empty comment from the description, on every sync.",
  },

  // --- openapi.* ---
  "openapi.enabled": {
    label: "Publish the OpenAPI document",
    description: "Serves /api/openapi.json to API callers, showing what their own roles can reach. Off = 404; admins still see it under Docs.",
    links: [{ page: "docs" }],
  },
  "openapi.include_examples": {
    label: "Include example values",
    description: "Adds a sample value to every column and argument, for tools that show or generate requests from the document.",
  },
  "openapi.cache_enabled": {
    label: "Cache generated documents",
    description: "Keeps each role set's document until the schema, permissions, workflows or settings change, instead of rebuilding it on every request.",
  },

  // --- mcp.* ---
  "mcp.enabled": {
    label: "Enable MCP",
    description: "Serves the MCP server at this instance's address, /mcp, for an agent with an administrator's token. Off = /mcp doesn't answer, and the stdio binary refuses to start.",
    primary: true,
  },
  "mcp.mode": {
    label: "Mode",
    description: "What an agent may do at all - on top of every permission TotalBase checks anyway.",
    input: "cards",
    options: [
      { label: "Read only", value: "READ_ONLY", description: "Only tools that read: describe, list, query, get." },
      { label: "Standard", value: "STANDARD", description: "Build and change everything, but never delete or revoke - a destructive call is refused." },
      { label: "Full", value: "FULL", description: "Everything, deletions included - each one still needs confirm=true." },
    ],
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_schema": {
    label: "Tables and schema",
    description: "Create and change tables, schemas, columns' and rows' presentation, resources' exposure; describe them.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_records": {
    label: "Records",
    description: "Read and write rows of any exposed table - the application's and TotalBase's own - and call functions.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_access": {
    label: "Permissions",
    description: "Grant, revoke and read permissions; capabilities; default permissions.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_users": {
    label: "Users",
    description: "Create users with a password or an invitation, change their roles, send links.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_screens": {
    label: "DataViews and pages",
    description: "Create, change, publish and delete DataViews, CUSTOM pages and the App menu.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_dashboards": {
    label: "Dashboards",
    description: "Create, change, publish and delete dashboards and their widgets.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_workflows": {
    label: "Workflows",
    description: "Create, save, run, publish, enable and delete workflows.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_templates": {
    label: "Templates",
    description: "Create, change and try email and PDF templates.",
    section: "Tools",
    dependsOn: "mcp.enabled",
  },
  "mcp.tools_sql": {
    label: "SQL",
    description: "Raw SQL and its plans - also needs SQL Console's Allow API tokens.",
    section: "Tools",
    links: [{ setting: "sql_console.token_access" }],
    dependsOn: "mcp.enabled",
  },
  "mcp.instructions": {
    label: "Project instructions",
    description: "Told to every agent with the server's own orientation - this project's conventions: names, language, its domain, what never to touch.",
    input: "textarea",
    section: "Agent",
    dependsOn: "mcp.enabled",
  },
  "mcp.rate_limit_per_minute": {
    label: "Requests per minute",
    description: "The most MCP requests one token makes in a minute - each tool call is one. Its own calls to the APIs don't count toward Network's limit.",
    unit: "requests",
    section: "Agent",
    dependsOn: "mcp.enabled",
  },
  "mcp.allowed_hosts": {
    label: "Allowed hosts",
    description: "The Host a request to /mcp may name - refuses a page that tricks a browser into calling it (DNS rebinding). Empty: the public URL's host, and localhost.",
    section: "Agent",
    dependsOn: "mcp.enabled",
  },

  // --- realtime.* ---
  "realtime.enabled": {
    label: "Enable Realtime",
    description: "Serves /api/realtime. Needs PostgreSQL's logical replication: wal_level = logical and the REPLICATION attribute on TotalBase's role. Off = the endpoint doesn't answer; the tables keep their Realtime exposure.",
    primary: true,
  },
  "realtime.max_subscriptions": {
    label: "Subscriptions per connection",
    description: "The most subscriptions one WebSocket holds at once.",
    unit: "subscriptions",
    dependsOn: "realtime.enabled",
  },
  "realtime.heartbeat_seconds": {
    label: "Heartbeat",
    description: "How often the server pings each connection; one that doesn't answer before the next ping is closed.",
    unit: "seconds",
    dependsOn: "realtime.enabled",
  },

  // --- graphql.* ---
  "graphql.enabled": {
    label: "Enable GraphQL",
    description: "Serves POST /api/graphql with a Data API token. Every field runs through the same permissions, limits and audit as the REST call it stands for. Off = 404.",
    primary: true,
  },
  "graphql.default_schema": {
    label: "Default schema",
    description: "The schema whose tables, views and functions are named without a prefix: products, not public__products. Every other schema's keep theirs (sales__orders). Changing it renames them for every client.",
    dependsOn: "graphql.enabled",
  },
  "graphql.max_calls": {
    label: "Data API calls per request",
    description: "The most Data API calls one request makes: each root field is one, and so is each one-to-many field, however many rows it is under.",
    unit: "calls",
    dependsOn: "graphql.enabled",
  },
  "graphql.max_depth": {
    label: "Selection depth",
    description: "How deep a request's selection may nest, introspection included. How far relations go is api.max_relation_depth.",
    unit: "levels",
    dependsOn: "graphql.enabled",
  },

  // --- sql_console.* ---
  "sql_console.enabled": {
    label: "Enable SQL Console",
    description: "Lets admins run raw SQL from the console. Off = the console can't execute or explain; its history stays readable.",
    primary: true,
  },
  "sql_console.token_access": {
    label: "Allow API tokens",
    description: "Lets an administrator's personal access token run SQL - the MCP server's agent, a script. Off = only a signed-in administrator. Changed from here only, never by a token.",
    links: [{ setting: "mcp.tools_sql" }],
    dependsOn: "sql_console.enabled",
  },
  "sql_console.max_rows": {
    label: "Result row cap",
    description: "The most rows a query shows in the console - the query still runs in full; extra rows are left out of the result.",
    unit: "rows",
    dependsOn: "sql_console.enabled",
  },
  "sql_console.history_retention_days": {
    label: "History retention",
    description: "How long a query stays in the SQL Console's history before it's purged automatically.",
    unit: "days",
  },

  // --- dataviews.* ---
  "dataviews.export_max_rows": {
    label: "Export row cap",
    description: "The most rows the \"All matching rows\" scope will fetch when exporting a DataView (CSV/Excel). Extra matching rows beyond this are silently dropped, with a warning shown to whoever ran the export.",
    unit: "rows",
    section: "Export & print",
  },
  "dataviews.export_warning_threshold": {
    label: "Export warning threshold",
    description: "Row count above which exporting \"All matching rows\" shows a \"this can take a few seconds\" warning before running. Also used for the same warning when importing a large file.",
    unit: "rows",
    section: "Export & print",
  },
  "dataviews.print_max_rows": {
    label: "Print row cap",
    description: "The most rows the \"All matching rows\" scope will fetch when printing a DataView to PDF. Extra matching rows beyond this are silently dropped, with a warning shown to whoever ran the print.",
    unit: "rows",
    section: "Export & print",
  },
  "dataviews.print_warning_threshold": {
    label: "Print warning threshold",
    description: "Row count above which printing \"All matching rows\" shows a \"this can take a few seconds\" warning before running.",
    unit: "rows",
    section: "Export & print",
  },
  "dataviews.map_max_points": {
    label: "Map point cap",
    description: "The most rows a MAP DataView plots at once (it has no pager - every relevant pin loads up front). Extra matching rows beyond this aren't fetched, with a notice shown on the map.",
    unit: "points",
    section: "Layout caps",
  },
  "dataviews.kanban_max_cards": {
    label: "Kanban card cap",
    description: "The most rows a KANBAN DataView loads at once, across every lane combined (it has no pager - every relevant card loads up front). Extra matching rows beyond this aren't fetched, with a notice shown on the board.",
    unit: "cards",
    section: "Layout caps",
  },
  "dataviews.calendar_max_events": {
    label: "Calendar event cap",
    description: "The most rows a CALENDAR DataView loads at once for the visible date range (it already fetches by month, not all-time - this is a defensive backstop for an unusually busy month). Extra matching rows beyond this aren't fetched, with a notice shown on the calendar.",
    unit: "events",
    section: "Layout caps",
  },
  "dataviews.toolbar_mode": {
    label: "Toolbar",
    description: "How a list DataView's toolbar opens for someone who hasn't chosen - unless the DataView sets its own. Compact moves Search and the menu into the page header and tucks import, export, print, history and columns into the menu. A phone or tablet is always compact.",
    input: "cards",
    options: [
      { label: "Automatic", value: "auto", description: "Compact - TotalBase's own default for every type." },
      { label: "Full", value: "full", description: "Every action in a toolbar row." },
      { label: "Compact", value: "compact", description: "Search and the menu in the page header." },
    ],
    section: "Toolbar",
  },
  "dataviews.record_content_width": {
    label: "Record page width",
    description: "How wide a record page's content grows - a FORM, a MASTER_DETAIL, a list's record opened on its own page - unless the DataView sets its own.",
    input: "cards",
    options: [
      { label: "Narrow", value: "narrow", description: "A readable column - a form of a few fields, a one-step screen." },
      { label: "Wide", value: "wide", description: "Room for two or three columns of fields." },
      { label: "Full width", value: "full", description: "The whole page." },
    ],
    section: "Page width",
  },
  "dataviews.custom_content_width": {
    label: "CUSTOM page width",
    description: "How wide a CUSTOM page's content and its pinned footer grow - unless the DataView sets its own.",
    input: "cards",
    options: [
      { label: "Narrow", value: "narrow", description: "A readable column - a form of a few fields, a one-step screen." },
      { label: "Wide", value: "wide", description: "Room for two or three columns of fields." },
      { label: "Full width", value: "full", description: "The whole page." },
    ],
    section: "Page width",
  },
  "dataviews.table_margin": {
    label: "Table margin",
    description: "The space around a TABLE's grid in the App, unless the DataView sets its own. Cards, maps, boards, calendars and timelines keep the normal margin; record pages, forms, pages and dashboards their own.",
    input: "cards",
    options: [
      { label: "Normal", value: "normal", description: "The page's usual margin - the header row of the table a rounded strip." },
      { label: "Compact", value: "compact", description: "A narrow margin." },
      { label: "No margin", value: "none", description: "The list fills the page, right under its header." },
    ],
    section: "Page width",
  },
  "dataviews.content_align": {
    label: "Content align",
    description: "Where a page narrower than the screen sits - unless the DataView sets its own.",
    input: "cards",
    options: [
      { label: "Left", value: "left" },
      { label: "Center", value: "center" },
      { label: "Right", value: "right" },
    ],
    section: "Page width",
  },
  "dataviews.gantt_max_bars": {
    label: "Gantt bar cap",
    description: "The most rows a GANTT DataView loads at once, across every lane combined (it has no pager - every relevant bar loads up front). Extra matching rows beyond this aren't fetched, with a notice shown on the timeline.",
    unit: "bars",
    section: "Layout caps",
  },
  "dataviews.tree_max_nodes": {
    label: "Tree node cap",
    description: "The most rows a TREE DataView loads at once - the whole hierarchy, every level (it has no pager). Extra matching rows beyond this aren't fetched, with a notice shown on the tree.",
    unit: "nodes",
    section: "Layout caps",
  },
  "dataviews.bulk_edit_max_rows": {
    label: "Bulk edit cap",
    description: "The most rows a viewer may choose and edit together - at most 100, the largest page a grid offers. Lower it to keep bulk edits smaller.",
    unit: "rows",
    section: "Layout caps",
  },
  "dataviews.save_max_operations": {
    label: "Record save cap",
    description: "The most writes one save of a record and its lines makes - the header and every line added, changed or removed, all in one transaction. A save beyond it is refused whole.",
    unit: "writes",
    section: "Layout caps",
  },
  // --- appearance.* --- (Admin_UI.md §4.1.1)
  "appearance.primary_color": {
    label: "Primary color",
    description: "The accent of every button, link and highlight. One color is enough: its lighter and darker shades are derived for light and dark mode. Empty keeps TotalBase's sky blue.",
    section: "Color",
    input: "color",
  },
  "appearance.neutral_color": {
    label: "Neutral color",
    description: "The grays of text, borders and backgrounds, in light and dark mode. Slate, TotalBase's own, leans blue - its dark mode too.",
    section: "Color",
    input: "cards",
    options: [
      { label: "Slate", value: "slate", description: "Bluish gray." },
      { label: "Gray", value: "gray", description: "A hint of blue." },
      { label: "Zinc", value: "zinc", description: "Cool, nearly pure gray." },
      { label: "Neutral", value: "neutral", description: "Pure gray." },
      { label: "Stone", value: "stone", description: "Warm gray." },
    ],
  },
  "appearance.color_mode": {
    label: "Color mode",
    description: "How the admin and the App look in a browser whose viewer hasn't picked a mode in their avatar menu - their own choice always wins.",
    section: "Color",
    input: "cards",
    options: [
      { label: "System", value: "SYSTEM", description: "Light or dark, following the viewer's device." },
      { label: "Light", value: "LIGHT", description: "Light everywhere." },
      { label: "Dark", value: "DARK", description: "Dark everywhere." },
      { label: "Midnight", value: "MIDNIGHT", description: "The rail and the panel dark, the content light." },
    ],
  },
  "appearance.login_layout": {
    label: "Sign-in page",
    orientation: "vertical",
    description: "What surrounds the sign-in card. Simple, Company panel and Image show your mark (Settings › General: your logo and name) and only a small \"Powered by TotalBase\" at the foot; on a phone they're the card under your mark (Image keeps its picture behind).",
    section: "Sign-in",
    input: "cards",
    options: [
      { label: "Default (TotalBase)", value: "SPLIT", description: "TotalBase's own panel - its headline, intro and features - beside the card." },
      { label: "Simple", value: "SIMPLE", description: "Your logo and name large and centered, your headline under them, the card below." },
      { label: "Company panel", value: "PANEL", description: "A side panel with your logo, name, headline and intro - over the background image if there is one, else your primary color - beside the card. Nothing of TotalBase." },
      { label: "Image", value: "IMAGE", description: "Your image across the page, your headline and intro over it, the card with your logo and name - left, center or right (Card position)." },
    ],
  },
  "appearance.login_card_position": {
    label: "Card position",
    description: "Where the Image layout's card sits on a wide screen - your headline and intro take the other side.",
    section: "Sign-in",
    input: "cards",
    options: [
      { label: "Left", value: "LEFT", description: "The card on the left, your words on the right." },
      { label: "Center", value: "CENTER", description: "The card in the middle, your headline above it." },
      { label: "Right", value: "RIGHT", description: "Your words on the left, the card on the right." },
    ],
  },
  "appearance.login_background": {
    label: "Background image",
    description: "The Image layout's background, and the Company panel's - a public image in Files, shown covering it. A photo of 1920 px or wider keeps sharp on a large screen.",
    section: "Sign-in",
    input: "image",
  },
  "appearance.login_headline": {
    label: "Headline",
    description: "Your words on the sign-in page: under your name (Simple), in the Company panel, over the Image layout's background. Up to 120 characters.",
    section: "Sign-in",
  },
  "appearance.login_intro": {
    label: "Intro",
    description: "Under the headline, in the Company panel and the Image layout, on a wide screen. Up to 300 characters.",
    section: "Sign-in",
  },
  "appearance.custom_css": {
    label: "Custom CSS",
    description: "Plain CSS applied last on every page - the admin, the App, sign-in, embeds. Stable to build on: Nuxt UI's tokens (--ui-primary, --ui-color-primary-*, --ui-bg, --ui-text, --ui-border, --ui-radius, --font-sans), .dark, and html[data-surface=\"app\"] (admin, app, auth, embed) to target one surface, [data-shell=\"rail\"], \"panel\", \"header\" or \"main\" for a part of the shell. Anything else may change between versions. No @import. If a rule hides the UI, open any page with ?safe-css to load without it.",
    section: "Custom CSS",
    input: "css",
  },

  // --- maps.* --- (every map: MAP DataViews, map fields, dashboard maps)
  "maps.tiles": {
    label: "Map tiles",
    description: "What every map draws underneath - MAP DataViews, map fields and dashboard maps. Mapbox needs a public token below; without one, maps keep OpenStreetMap.",
    options: [{ label: "OpenStreetMap", value: "OPENSTREETMAP" }, { label: "Mapbox", value: "MAPBOX" }],
    links: [{ setting: "maps.mapbox_token" }],
  },
  "maps.mapbox_token": {
    label: "Mapbox public token",
    description: "A public token (pk.…) from your Mapbox account, restricted there to this instance's URL - it is sent to every viewer's browser. A secret token (sk.…) is refused.",
    links: [{ setting: "system.public_url" }],
  },
  "maps.default_view": {
    label: "Default map view",
    description: "Where an empty map field opens - latitude, longitude, zoom (e.g. -24.79, -65.41, 12 for Salta). Empty: the whole world.",
  },
  "maps.mapbox_style": {
    label: "Mapbox style",
    description: "username/style_id - mapbox/streets-v12, mapbox/satellite-streets-v12, mapbox/light-v11, or a style of your own from Mapbox Studio.",
  },

  // --- dashboards.* ---
  "app.menu_mode": {
    label: "Menu display",
    description: "Tree: a collapsible hierarchy of groups. Sidebar: the same menu flat, each group a section heading.",
    options: [{ label: "Tree", value: "TREE" }, { label: "Sidebar", value: "SIDEBAR" }],
  },
  "app.menu_groups_open": {
    label: "Groups when the App opens",
    description: "How the tree menu's groups start - a group may set its own. The one holding the page always opens; what each viewer opens and closes is remembered on their device.",
    options: [
      { label: "Only the current page's", value: "CURRENT" },
      { label: "All open", value: "OPEN" },
      { label: "All closed", value: "CLOSED" },
    ],
  },
  "app.menu_search": {
    label: "Search box",
    description: "A search box over the menu - by an entry's label, its full name, its description or its group. Automatic: once a viewer sees more than 15 entries.",
    options: [
      { label: "Automatic", value: "AUTO" },
      { label: "Always", value: "ALWAYS" },
      { label: "Never", value: "NEVER" },
    ],
  },
  "dashboards.query_timeout_ms": {
    label: "Widget query timeout",
    description: "Maximum time a dashboard widget's SQL may run (it always runs in a read-only transaction) before PostgreSQL cancels it.",
    unit: "ms",
  },
  "dashboards.query_max_rows": {
    label: "Widget query row cap",
    description: "The most rows a dashboard widget's SQL returns - extra rows are cut off, not paged.",
    unit: "rows",
  },
  "dashboards.max_concurrent_queries": {
    label: "Widget queries at once",
    description: "How many widget queries of one dashboard run at the same time - the rest wait their turn, so a large dashboard never takes every connection the Data API needs.",
    unit: "queries",
  },
  "dashboards.cache_seconds": {
    label: "Widget result cache",
    description: "How long a published widget's result is reused for the same variables, viewer and time zone - unless its dashboard refreshes more often. Refresh skips it. 0 turns it off.",
    unit: "seconds",
  },
  "dashboards.embed_secret_key": {
    label: "Embedding secret",
    description: "The Settings → Secrets entry your site's backend signs embed tokens with (HS256) - it never reaches a browser. Empty: no dashboard can be embedded. Rotate it by creating a new secret and choosing it here; tokens signed with the old one stop working.",
    input: "secret",
    section: "Embedding",
  },
  "dashboards.embed_max_ttl_minutes": {
    label: "Longest embed token",
    description: "A token whose expiry (exp) is further away than this is refused - keep embed tokens short-lived and sign a new one per page view.",
    unit: "minutes",
    section: "Embedding",
  },
  "dashboards.embed_allowed_origins": {
    label: "Sites that may embed",
    description: "Origins allowed to frame an embedded dashboard (https://app.example.com) - sent as Content-Security-Policy frame-ancestors. Empty: no site can frame one.",
    section: "Embedding",
  },

  // --- workflows.* ---
  "workflows.max_sync_wait_ms": {
    label: "Maximum synchronous wait",
    description: "The longest a WEBHOOK trigger's synchronous response mode will hold the connection open waiting for the run to finish, regardless of what an individual workflow's own wait time is configured to.",
    unit: "ms",
    section: "Runs",
  },
  "workflows.max_run_duration_ms": {
    label: "Maximum run duration",
    description: "A run still executing past this is force-failed - the engine's own admission deadline, independent of any single step's own timeout.",
    unit: "ms",
    section: "Runs",
  },
  "workflows.max_operations_per_run": {
    label: "Maximum operations per run",
    description: "Caps the total number of steps (including loop iterations) a single run can execute before it's force-failed, to catch a runaway or accidentally-looping design.",
    section: "Runs",
  },
  "workflows.max_iteration_items": {
    label: "Maximum iteration items",
    description: "The most items a For each step's own collection can contain - a longer collection fails the step rather than iterating partially.",
    section: "Runs",
  },
  "workflows.max_runtime_value_bytes": {
    label: "Maximum binding value size",
    description: "Caps the size of any single resolved binding value (trigger data, a step's own result, an iteration item) - a larger value fails the step that tried to resolve it.",
    unit: "bytes",
    section: "Runs",
  },
  "workflows.max_history_payload_bytes": {
    label: "Maximum history payload size",
    description: "Caps how much of a step's input/result is retained in DETAILED history - anything beyond this is truncated before it's persisted.",
    unit: "bytes",
    section: "History",
  },
  "workflows.history_summary_retention_days": {
    label: "Summary history retention",
    description: "How long a SUMMARY-level run's history (status and timing, no payloads) is kept before it's purged.",
    unit: "days",
    section: "History",
  },
  "workflows.history_detailed_retention_days": {
    label: "Detailed history retention",
    description: "How long a DETAILED-level run's history (including redacted/capped step payloads) is kept before it's purged - shorter than summary retention by default, since it holds more sensitive data.",
    unit: "days",
    section: "History",
  },
  "workflows.auto_disable_after_consecutive_failures": {
    label: "Auto-disable after consecutive failures",
    description: "A workflow that fails this many runs in a row (of any trigger type) is automatically disabled - most useful for a CRON workflow, which would otherwise keep retrying forever with no external caller to notice.",
    unit: "failures",
    section: "Runs",
  },
  "workflows.max_chain_depth": {
    label: "Maximum chain depth",
    description: "How many workflows one causal chain may hold - a workflow whose write starts another (data events) or that calls another (Execute workflow). A loop (A → A, A → B → A) is refused at any depth.",
    unit: "workflows",
    section: "Runs",
  },
  "workflows.http_max_request_bytes": {
    label: "HTTP request maximum body",
    description: "The largest body an HTTP request step may send. A larger one fails the step before anything is sent.",
    unit: "bytes",
    section: "HTTP request",
  },
  "workflows.http_max_response_bytes": {
    label: "HTTP response maximum body",
    description: "The largest response an HTTP request step reads. The transfer is cut once it goes past this, and the step fails.",
    unit: "bytes",
    section: "HTTP request",
  },
  "workflows.http_allowed_hosts": {
    label: "HTTP request allowed hosts",
    description: "Hostnames (api.internal.example), IP addresses or CIDR ranges (10.0.0.0/8) an HTTP request step may reach although they are private, loopback or link-local. Every other such destination is refused.",
    section: "HTTP request",
  },
};
