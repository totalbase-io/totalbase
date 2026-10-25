import type { LoginCardPosition, LoginLayout, McpMode, NeutralColor } from "@totalbase/shared";
import { MAIL_TEMPLATE_DEFAULTS, type MailTemplate } from "./mail-templates.js";

/**
 * Typed settings registry. Defaults live in code; PostgreSQL stores only
 * overrides (Administration.md §7.1).
 *
 * Every key here is read by some code path; do not pre-declare a setting
 * nothing uses yet (AGENTS.md section 3).
 */
export interface SettingsRegistry {
  "api.default_limit": number;
  "api.max_limit": number;
  "api.max_offset": number;
  "api.max_relation_depth": number;
  "api.max_filter_depth": number;
  "api.require_where_for_update": boolean;
  "api.require_where_for_delete": boolean;
  "api.bulk_max_items": number;
  "api.max_body_bytes": number;
  "api.max_query_string_bytes": number;
  "api.max_query_parameters": number;
  "api.max_query_nodes": number;

  // statement_timeout of every Data API request's transaction
  // (apps/server data-api-timeout.ts) - PostgreSQL cancels past it.
  "api.request_timeout_ms": number;
  // What Data API callers' queries may use (Data_API.md §3.12) - features
  // that get expensive on large tables without the right index. Admin-
  // written filters (row filters, payload checks, workflows) ignore them.
  "api.allow_count": boolean;
  "query.allow_regex": boolean;
  "query.allow_contains": boolean;
  "query.allow_having": boolean;

  "api.nested_write_max_depth": number;
  "api.nested_write_max_records": number;

  "auth.registration_enabled": boolean;
  /** Role id assigned to an account created by POST /api/auth/register; "" = none. Never reserved or admin_access. */
  "auth.registration_default_role": string;
  "auth.email_verification_required": boolean;
  "auth.password_min_length": number;
  "auth.session_ttl_hours": number;
  /** Minutes a session may go unused before it stops validating; 0 = off (Security.md §2.2). */
  "auth.session_idle_minutes": number;
  /** Minutes a sign-in or re-authentication lets a session do what asks for one (Security.md §2.19). */
  "auth.reauthentication_minutes": number;
  /** Days an account may go unused before the hourly job deactivates it; 0 = off (Security.md §1.11). */
  "auth.dormant_account_days": number;
  "auth.password_reset_ttl_minutes": number;
  "auth.email_verification_ttl_hours": number;
  "auth.invitation_ttl_hours": number;
  "auth.max_sessions_per_user": number;
  "auth.session_retention_days": number;
  // Account lockout: this many consecutive failed sign-ins lock the
  // account for lockout_duration_minutes. 0 turns lockout off.
  "auth.lockout_max_attempts": number;
  "auth.lockout_duration_minutes": number;
  /** Who must sign in with a second factor (Security.md §2.17): NONE, ADMINISTRATORS (holders of the Administrators role) or EVERYONE. */
  "auth.mfa_required": string;
  // Where the single-use links in system emails point - `{{public_url}}`
  // and `{{token}}` are filled in by TotalBase. Default: the built-in
  // pages under /auth/*; point them at your own app instead.
  "auth.links.invitation": string;
  "auth.links.password_reset": string;
  "auth.links.email_verification": string;
  "auth.password_changed_email_enabled": boolean;
  "auth.email_changed_email_enabled": boolean;
  "auth.mfa_disabled_email_enabled": boolean;
  "auth.token_created_email_enabled": boolean;
  "auth.welcome_email_enabled": boolean;
  "auth.access_review_interval_days": number;

  // Canonical external identity of this instance (Administration.md §7.6).
  // Empty `public_url` = fall back to the TOTALBASE_PUBLIC_URL env var.
  "system.public_url": string;
  "system.instance_name": string;
  // The instance's mark (Admin_UI.md §4.1.1): the id of a PUBLIC image in Files; empty, the built-in one.
  "system.logo": string;
  // The UI's language for whoever chose none in My account, and for pages
  // with no user (sign-in, embeds) - Admin_UI.md §14.
  "system.language": string;
  // Instance-wide display defaults (apps/admin/app/utils/format-pattern.ts):
  // the zone a `timestamptz` value is converted into before display, and
  // the fallback date-fns patterns for a date/time/timestamp column whose
  // own `config.displayFormat` isn't set - a field's own Format always
  // wins. Empty = no default: the viewer's browser zone, the raw value.
  "system.timezone": string;
  "system.timezone_user_choice": boolean;
  "system.date_format": string;
  "system.time_format": string;
  "system.datetime_format": string;

  // The operator's branding (Admin_UI.md §4.1.1): served
  // public, before sign-in, by /api/instance and /theme.css.
  /** Id of a PUBLIC image in Files shown as the product mark; "" = the built-in mark. */
  /** #rrggbb; "" = the product's blue. */
  "appearance.primary_color": string;
  /** The grays (text, borders, backgrounds) - one of Tailwind's five. */
  "appearance.neutral_color": NeutralColor;
  "appearance.login_layout": LoginLayout;
  "appearance.login_card_position": LoginCardPosition;
  /** Id of a PUBLIC image in Files - the IMAGE layout's background. */
  "appearance.login_background": string;
  "appearance.login_headline": string;
  "appearance.login_intro": string;
  /** Plain CSS, applied last on every page the SPA serves. */
  "appearance.custom_css": string;

  // System email templates (Administration.md §8.2) - see mail-templates.ts.
  "mail.templates.user_invitation": MailTemplate;
  "mail.templates.password_reset": MailTemplate;
  "mail.templates.email_verification": MailTemplate;
  "mail.templates.password_changed": MailTemplate;
  "mail.templates.email_changed": MailTemplate;
  "mail.templates.mfa_disabled": MailTemplate;
  "mail.templates.token_created": MailTemplate;
  "mail.templates.user_welcome": MailTemplate;

  "api_keys.default_ttl_days": number;
  "api_keys.rotation_warning_days": number;
  "api_keys.purge_after_days": number;

  "audit.enabled": boolean;
  "audit.retention_days": number;
  "audit.store_sql": boolean;
  "audit.store_sql_params": boolean;

  "security.rate_limit_enabled": boolean;
  "security.rate_limit_per_minute": number;
  "security.rate_limit_sign_in_per_minute": number;
  "security.cors_enabled": boolean;
  "security.cors_origins": string[];
  "security.trust_proxy": boolean;

  "files.enabled": boolean;
  "files.max_file_size_bytes": number;
  "files.allowed_mime_types": string[];
  "files.default_visibility_public": boolean;
  "files.storage_provider": string;
  "files.storage_local_path": string;

  "files.transforms.enabled": boolean;
  "files.transforms.max_width": number;
  "files.transforms.max_height": number;
  "files.transforms.max_pixels": number;
  "files.transforms.max_concurrent": number;
  "files.transforms.timeout_ms": number;
  "files.transforms.cache_ttl_seconds": number;
  "files.transforms.max_operations": number;
  /** JSON-encoded Record<string, TransformPreset> - see @totalbase/files transform-params.ts. */
  "files.transforms.presets_json": string;

  "idempotency.enabled": boolean;
  "idempotency.ttl_hours": number;
  "idempotency.max_response_bytes": number;

  "transactions.enabled": boolean;
  "transactions.max_operations": number;
  "transactions.timeout_ms": number;

  "async_executions.enabled": boolean;
  "async_executions.max_retries": number;
  "async_executions.retry_delay_seconds": number;
  "async_executions.stale_timeout_ms": number;
  "async_executions.poll_interval_ms": number;
  "async_executions.retention_days": number;
  "outbox.retention_days": number;
  "outbox.max_attempts": number;
  "outbox.retry_delay_seconds": number;
  "outbox.lease_seconds": number;

  // The PostgreSQL connection pool (AGENTS.md section 19B), applied at
  // startup: @totalbase/database starts on these defaults and apps/server's
  // bootstrap rebuilds the pool from the stored values.
  "pool.max": number;
  "pool.idle_timeout_ms": number;
  "pool.connection_timeout_ms": number;
  "pool.max_lifetime_ms": number;

  // Catalog sync (apps/server catalog-refresh.ts): a cheap check for DDL
  // made outside TotalBase that syncs when it finds some (0 = off), a
  // scheduled full sync as its safety net (0 = off), a reconcile after each
  // SQL Console run, and COMMENT ON <-> resource description sync.
  "catalog.watch_interval_seconds": number;
  "catalog.refresh_interval_minutes": number;
  "catalog.auto_refresh_after_ddl": boolean;
  "catalog.track_comments": boolean;

  // The generated Data API document (Data_API.md §14.1): published at
  // /api/openapi.json at all, with sample values, and cached per viewer
  // until an Admin API write or a catalog refresh (apps/server
  // openapi-cache.ts).
  "openapi.enabled": boolean;
  "openapi.include_examples": boolean;
  "openapi.cache_enabled": boolean;

  // The MCP server the TotalBase server itself serves at /mcp
  // (Administration.md §11.7) - and the policy the stdio
  // binary applies too. Changed by a signed-in administrator only.
  "mcp.enabled": boolean;
  "mcp.mode": McpMode;
  "mcp.tools_schema": boolean;
  "mcp.tools_records": boolean;
  "mcp.tools_access": boolean;
  "mcp.tools_users": boolean;
  "mcp.tools_screens": boolean;
  "mcp.tools_dashboards": boolean;
  "mcp.tools_workflows": boolean;
  "mcp.tools_templates": boolean;
  "mcp.tools_sql": boolean;
  "mcp.instructions": string;
  "mcp.rate_limit_per_minute": number;
  "mcp.allowed_hosts": string[];

  "sql_console.enabled": boolean;
  // Raw SQL through a personal access token (the MCP server's agent, a
  // script) - off by default, changed from a signed-in session only.
  "sql_console.token_access": boolean;
  "sql_console.max_rows": number;
  "sql_console.history_retention_days": number;

  // SMTP relay config - read by the system emails and the workflow Send
  // email operation (Administration.md §8).
  "smtp.host": string;
  "smtp.port": number;
  "smtp.secure": boolean;
  "smtp.username": string;
  /** Secret key name in @totalbase/secrets, not the plaintext password. Empty string = not configured. */
  "smtp.password_secret_key": string;
  "smtp.from": string;

  // One S3-compatible bucket, shared by what stores objects outside the
  // database - Files today (Administration.md §7.9). The secret access key
  // is a Settings → Secrets entry, named by s3.secret_key.
  "s3.enabled": boolean;
  "s3.endpoint": string;
  "s3.region": string;
  "s3.bucket": string;
  "s3.prefix": string;
  "s3.path_style": boolean;
  "s3.access_key_id": string;
  "s3.secret_key": string;

  // Built-in backups (Administration.md §12): a scheduled pg_dump of the
  // database, the locally stored files and a manifest - never the master key.
  "backups.enabled": boolean;
  "backups.schedule": string;
  "backups.keep": number;
  "backups.destination": string;
  "backups.local_path": string;
  "backups.include_files": boolean;


  // DataViews Export "All matching rows" scope (DataViewGrid.vue's own
  // fetchAllMatchingRows) - separate from the print.* pair below even
  // though both go through that same fetch-everything path, since an
  // instance may want a much higher (or lower) cap for a CSV/Excel
  // download than for a PDF it has to lay out and render client-side.
  "dataviews.export_max_rows": number;
  "dataviews.export_warning_threshold": number;

  // DataViews Print "All matching rows" scope - see export.* above.
  "dataviews.print_max_rows": number;
  "dataviews.print_warning_threshold": number;

  // MAP DataViews (DataViews.md §5.4)
  // - a map wants every relevant pin at once, not one page of 20 like
  // TABLE/CARDS, but rendering unbounded points still isn't free -
  // separate from export/print.* above since it bounds a live DOM render
  // (Leaflet markers/clusters), not a batch fetch for a one-shot
  // download/PDF.
  "dataviews.map_max_points": number;
  // KANBAN DataViews - same reasoning as `map_max_points` just above: a
  // board wants every relevant card at once (no pager, cards move between
  // lanes by drag), so this bounds the live DOM render (one <div> per
  // card across every lane combined) instead of a batch fetch.
  "dataviews.kanban_max_cards": number;
  // CALENDAR DataViews - unlike MAP/KANBAN's own flat cap just above, a
  // CALENDAR's own fetch is already bounded by the visible month's date
  // range (navigating prev/next month refetches a new range rather than
  // loading everything up front), so this is a defensive backstop, not
  // the primary limit - a guard against a single real month somehow
  // holding thousands of events, bounding the live DOM render (one chip
  // per event across every day cell) the same way map_max_points/
  // kanban_max_cards do for their own type.
  "dataviews.calendar_max_events": number;
  // GANTT DataViews - same reasoning as `map_max_points`/`kanban_max_cards`
  // just above: a timeline wants every relevant bar at once (no pager, no
  // drag-to-reschedule in v1 either), so this bounds the live DOM render
  // (one bar per row across every lane combined) instead of a batch fetch.
  "dataviews.gantt_max_bars": number;
  "dataviews.tree_max_nodes": number;
  "dataviews.save_max_operations": number;
  "dataviews.bulk_edit_max_rows": number;
  // A list DataView's toolbar for a viewer with no choice of their own and a DataView that sets none
  // (view_config.default_state.toolbarMode) - auto: compact for CARDS, full otherwise (DataViews.md §5).
  "dataviews.toolbar_mode": "auto" | "full" | "compact";
  // How wide a page's content grows for a DataView that sets none (view_config.page_content_width / _align,
  // DataViews.md §6.7): a record page (FORM, MASTER_DETAIL, a list's record on its own page)
  // and a CUSTOM page apart - the product's own, narrow and full, as they always were.
  "dataviews.record_content_width": "narrow" | "wide" | "full";
  "dataviews.custom_content_width": "narrow" | "wide" | "full";
  "dataviews.content_align": "left" | "center" | "right";
  // The space around a TABLE's grid for a DataView that sets none (view_config.list_margin, DataViews.md
  // §5) - none: the table fills the page under its header. The other lists keep the normal margin.
  "dataviews.table_margin": "none" | "compact" | "normal";

  // Map tiles for every map in the instance - MAP DataViews, the map widgets,
  // dashboard MAP widgets (DataViews.md §5.4). Mapbox raster
  // tiles in the same Leaflet maps; its token is a public (pk.) one, meant
  // for the browser and restricted by URL in the Mapbox account - not a secret.
  "maps.tiles": "OPENSTREETMAP" | "MAPBOX";
  "maps.mapbox_token": string;
  "maps.mapbox_style": string;
  "maps.default_view": string;

  // Dashboards: every widget's SQL runs read-only under these bounds
  // (Dashboards.md §2 - SQL widgets).
  "dashboards.query_timeout_ms": number;
  "dashboards.query_max_rows": number;
  // How many widget queries of one dashboard run at once, and how long a published
  // widget's result is reused (0 = none) - D24.
  "dashboards.max_concurrent_queries": number;
  "dashboards.cache_seconds": number;
  // Signed embedding (Dashboards.md §9.5): the Settings → Secrets
  // entry embed tokens are signed with ("" = embedding off), the longest a
  // token may live, and the sites that may frame an embed.
  "dashboards.embed_secret_key": string;
  "dashboards.embed_max_ttl_minutes": number;
  "dashboards.embed_allowed_origins": string[];

  // The App menu's display (Security.md §8.2): TREE (a
  // collapsible hierarchy) or SIDEBAR (flat, groups as section headings).
  "app.menu_mode": string;
  /** How the tree menu's groups start: CURRENT (only the one holding the page), OPEN or CLOSED. A group may set its own. */
  "app.menu_groups_open": "CURRENT" | "OPEN" | "CLOSED";
  "app.menu_search": "AUTO" | "ALWAYS" | "NEVER";

  // Workflows execution engine (specs/Workflows.md §8.5).
  // max_operations_per_run/max_run_duration_ms are read from Fase 1
  // (the sequential engine's step budget and admission deadline); the rest
  // are declared now, as one bounded group, but only actually consumed
  // starting with the phase that needs them: max_iteration_items (For
  // each's loop body), max_runtime_value_bytes (binding size guard),
  // max_history_payload_bytes/history_*_retention_days (history), and
  // max_sync_wait_ms (the WEBHOOK trigger's synchronous response mode).
  "workflows.max_sync_wait_ms": number;
  "workflows.max_run_duration_ms": number;
  "workflows.max_operations_per_run": number;
  "workflows.max_iteration_items": number;
  "workflows.max_runtime_value_bytes": number;
  "workflows.max_history_payload_bytes": number;
  "workflows.history_summary_retention_days": number;
  "workflows.history_detailed_retention_days": number;
  "workflows.auto_disable_after_consecutive_failures": number;
  "workflows.http_allowed_hosts": string[];
  "workflows.max_chain_depth": number;
  "workflows.http_max_request_bytes": number;
  "workflows.http_max_response_bytes": number;
}

export type SettingKey = keyof SettingsRegistry;

/** Defaults per Administration.md §7.4. */
export const SETTINGS_DEFAULTS: SettingsRegistry = {
  "api.default_limit": 50,
  "api.max_limit": 500,
  "api.max_offset": 100_000,
  "api.max_relation_depth": 3,
  "api.max_filter_depth": 10,
  "api.require_where_for_update": true,
  "api.require_where_for_delete": true,
  "api.bulk_max_items": 500,
  "api.max_body_bytes": 5_242_880,
  "api.max_query_string_bytes": 32_768,
  "api.max_query_parameters": 200,
  "api.max_query_nodes": 200,

  // Nested writes (Data_API.md §6.3). Depth
  // 0 is the root resource itself; default 2 allows parent + child +
  // grandchild, capped at 3 by the service layer.
  "api.request_timeout_ms": 30_000,
  "api.allow_count": true,
  "query.allow_regex": true,
  "query.allow_contains": true,
  "query.allow_having": true,
  "api.nested_write_max_depth": 2,
  "api.nested_write_max_records": 500,

  "auth.registration_enabled": false,
  "auth.registration_default_role": "",
  "auth.email_verification_required": true,
  "auth.password_min_length": 12,
  "auth.session_ttl_hours": 720,
  "auth.session_idle_minutes": 0,
  "auth.reauthentication_minutes": 15,
  "auth.dormant_account_days": 0,
  "auth.password_reset_ttl_minutes": 15,
  "auth.email_verification_ttl_hours": 24,
  "auth.invitation_ttl_hours": 168,
  "auth.max_sessions_per_user": 20,
  "auth.session_retention_days": 30,
  "auth.lockout_max_attempts": 5,
  "auth.lockout_duration_minutes": 15,
  "auth.mfa_required": "NONE",
  "auth.links.invitation": "{{public_url}}/auth/accept-invitation?token={{token}}",
  "auth.links.password_reset": "{{public_url}}/auth/reset-password?token={{token}}",
  "auth.links.email_verification": "{{public_url}}/auth/verify-email?token={{token}}",
  "auth.password_changed_email_enabled": true,
  "auth.email_changed_email_enabled": true,
  "auth.mfa_disabled_email_enabled": true,
  "auth.token_created_email_enabled": true,
  "auth.welcome_email_enabled": false,
  "auth.access_review_interval_days": 90,

  "system.public_url": "",
  "system.instance_name": "TotalBase",
  "system.logo": "",
  "system.language": "en",
  "system.timezone": "",
  "system.timezone_user_choice": false,
  "system.date_format": "",
  "system.time_format": "",
  "system.datetime_format": "",

  "appearance.primary_color": "",
  "appearance.neutral_color": "slate",
  "appearance.login_layout": "SPLIT",
  "appearance.login_card_position": "RIGHT",
  "appearance.login_background": "",
  "appearance.login_headline": "",
  "appearance.login_intro": "",
  "appearance.custom_css": "",

  "mail.templates.user_invitation": MAIL_TEMPLATE_DEFAULTS.user_invitation,
  "mail.templates.password_reset": MAIL_TEMPLATE_DEFAULTS.password_reset,
  "mail.templates.email_verification": MAIL_TEMPLATE_DEFAULTS.email_verification,
  "mail.templates.password_changed": MAIL_TEMPLATE_DEFAULTS.password_changed,
  "mail.templates.email_changed": MAIL_TEMPLATE_DEFAULTS.email_changed,
  "mail.templates.mfa_disabled": MAIL_TEMPLATE_DEFAULTS.mfa_disabled,
  "mail.templates.token_created": MAIL_TEMPLATE_DEFAULTS.token_created,
  "mail.templates.user_welcome": MAIL_TEMPLATE_DEFAULTS.user_welcome,

  "api_keys.default_ttl_days": 365,
  "api_keys.rotation_warning_days": 30,
  // ended tokens (revoked or expired) kept this long for review, then purged by the hourly retention job; 0 = forever
  "api_keys.purge_after_days": 30,

  "audit.enabled": true,
  "audit.retention_days": 365,
  "audit.store_sql": true,
  "audit.store_sql_params": false,

  "security.rate_limit_enabled": false,
  "security.rate_limit_per_minute": 3000,
  "security.rate_limit_sign_in_per_minute": 5,
  "security.cors_enabled": true,
  "security.cors_origins": [],
  "security.trust_proxy": false,

  // Files.
  "files.enabled": true,
  "files.max_file_size_bytes": 10_485_760,
  "files.allowed_mime_types": ["text/*", "image/*", "application/pdf", "application/json", "application/zip"],
  "files.default_visibility_public": false,
  "files.storage_provider": "local",
  "files.storage_local_path": "/var/lib/totalbase/files",

  // Image transformations for Files, ported from Assets.
  "files.transforms.enabled": true,
  "files.transforms.max_width": 4096,
  "files.transforms.max_height": 4096,
  "files.transforms.max_pixels": 16_000_000,
  "files.transforms.max_concurrent": 4,
  "files.transforms.timeout_ms": 5_000,
  "files.transforms.cache_ttl_seconds": 2_592_000, // 30 days
  "files.transforms.max_operations": 6,
  "files.transforms.presets_json": "{}",

  // Idempotency Keys (Data_API.md §9).
  "idempotency.enabled": true,
  "idempotency.ttl_hours": 24,
  // Responses above this size are not cached inline
  // (Data_API.md §9) - the operation still only ever runs once; a
  // retry against a truncated record gets an explicit error instead of
  // a replayed body. 64KB comfortably covers a single-row CREATE or a
  // bulk create bounded by api.bulk_max_items.
  "idempotency.max_response_bytes": 65_536,

  // Transactions (Data_API.md §8).
  "transactions.enabled": true,
  "transactions.max_operations": 20,
  "transactions.timeout_ms": 0,

  // Executions / async execution queue (Data_API.md §10).
  // stale_timeout_ms is the crash-recovery visibility
  // timeout for a worker that died mid-`running` (Data_API.md §10.2);
  // poll_interval_ms paces the in-process worker loop started in
  // apps/server/src/index.ts.
  "async_executions.enabled": true,
  "async_executions.max_retries": 3,
  "async_executions.retry_delay_seconds": 30,
  "async_executions.stale_timeout_ms": 120_000,
  "async_executions.poll_interval_ms": 2_000,
  // finished executions (COMPLETED/FAILED/CANCELLED) kept this long, then purged by the hourly retention job; 0 = forever
  "async_executions.retention_days": 7,
  "outbox.retention_days": 7,
  "outbox.max_attempts": 5,
  "outbox.retry_delay_seconds": 30, // doubles per attempt
  "outbox.lease_seconds": 1200, // above workflows.max_run_duration_ms (15 min): a dispatch runs its workflows

  // SQL Console history retention (Administration.md §5:
  // admin.sql_console_history_days = 90, renamed to match this registry's
  // per-package group naming convention). Applied by an automatic purge
  // job (apps/server/src/index.ts) in addition to the admin's manual
  // "purge before date" action.
  "pool.max": 20,
  "pool.idle_timeout_ms": 30_000,
  "pool.connection_timeout_ms": 5_000,
  "pool.max_lifetime_ms": 3_600_000,

  "catalog.watch_interval_seconds": 15,
  "catalog.refresh_interval_minutes": 10,
  "catalog.auto_refresh_after_ddl": true,
  "catalog.track_comments": true,

  "openapi.enabled": true,
  "openapi.include_examples": true,
  "openapi.cache_enabled": true,

  "mcp.enabled": false,
  "mcp.mode": "FULL",
  "mcp.tools_schema": true,
  "mcp.tools_records": true,
  "mcp.tools_access": true,
  "mcp.tools_users": true,
  "mcp.tools_screens": true,
  "mcp.tools_dashboards": true,
  "mcp.tools_workflows": true,
  "mcp.tools_templates": true,
  "mcp.tools_sql": true,
  "mcp.instructions": "",
  "mcp.rate_limit_per_minute": 600,
  "mcp.allowed_hosts": [],

  "sql_console.enabled": true,
  "sql_console.token_access": false,
  "sql_console.max_rows": 1_000,
  "sql_console.history_retention_days": 90,

  // SMTP relay config - the system emails and the workflow Send email operation.
  "smtp.host": "",
  "smtp.port": 587,
  "smtp.secure": false,
  "smtp.username": "",
  "smtp.password_secret_key": "",
  "smtp.from": "",
  "s3.enabled": false,
  "s3.endpoint": "",
  "s3.region": "us-east-1",
  "s3.bucket": "",
  "s3.prefix": "",
  "s3.path_style": false,
  "s3.access_key_id": "",
  "s3.secret_key": "",
  "backups.enabled": false,
  "backups.schedule": "0 3 * * *",
  "backups.keep": 7,
  "backups.destination": "local",
  "backups.local_path": "/var/lib/totalbase/backups",
  "backups.include_files": true,

  "dataviews.export_max_rows": 10_000,
  "dataviews.export_warning_threshold": 1_000,
  "dataviews.print_max_rows": 10_000,
  "dataviews.print_warning_threshold": 1_000,
  "dataviews.map_max_points": 500,
  "dataviews.kanban_max_cards": 500,
  "dataviews.calendar_max_events": 500,
  "dataviews.gantt_max_bars": 500,
  "dataviews.tree_max_nodes": 2000,
  "dataviews.save_max_operations": 500,
  "dataviews.bulk_edit_max_rows": 100,
  "dataviews.toolbar_mode": "auto",
  "dataviews.record_content_width": "narrow",
  "dataviews.custom_content_width": "full",
  "dataviews.content_align": "center",
  "dataviews.table_margin": "normal",
  "maps.tiles": "OPENSTREETMAP",
  "maps.mapbox_token": "",
  "maps.mapbox_style": "mapbox/streets-v12",
  "maps.default_view": "",
  "dashboards.query_timeout_ms": 10_000,
  "dashboards.query_max_rows": 1_000,
  "dashboards.max_concurrent_queries": 4,
  "dashboards.cache_seconds": 300,
  "dashboards.embed_secret_key": "",
  "dashboards.embed_max_ttl_minutes": 60,
  "dashboards.embed_allowed_origins": [],
  "app.menu_mode": "TREE",
  "app.menu_groups_open": "CURRENT",
  "app.menu_search": "AUTO",

  // Workflows (see the registry interface's own comment just above).
  "workflows.max_sync_wait_ms": 30_000,
  "workflows.max_run_duration_ms": 900_000, // 15 minutes
  "workflows.max_operations_per_run": 1_000,
  "workflows.max_iteration_items": 500,
  "workflows.max_runtime_value_bytes": 1_048_576, // 1 MiB
  "workflows.max_history_payload_bytes": 65_536, // 64 KiB
  "workflows.history_summary_retention_days": 30,
  "workflows.history_detailed_retention_days": 7,
  "workflows.auto_disable_after_consecutive_failures": 10,
  "workflows.http_allowed_hosts": [],
  "workflows.max_chain_depth": 8,
  "workflows.http_max_request_bytes": 1_048_576,
  "workflows.http_max_response_bytes": 5_242_880,
};

/**
 * Range of a numeric setting. Every numeric setting is a whole number
 * >= 0; this map only narrows that where 0 (or a large value) would break
 * the feature instead of meaning something - a page size of 0, a zero
 * timeout, a port outside 1-65535. Enforced by SettingsService on write
 * and returned by the Admin API's settings schema, so the admin's inputs
 * use the same bounds.
 */
export interface SettingBounds {
  min: number;
  max?: number;
}

export const SETTINGS_BOUNDS: Partial<Record<SettingKey, SettingBounds>> = {
  "api.default_limit": { min: 1 },
  "api.max_limit": { min: 1 },
  "api.max_relation_depth": { min: 1 },
  "api.max_filter_depth": { min: 1 },
  "api.bulk_max_items": { min: 1 },
  "api.request_timeout_ms": { min: 100, max: 3_600_000 },
  "api.max_body_bytes": { min: 1024 },
  "api.max_query_string_bytes": { min: 256 },
  "api.max_query_parameters": { min: 1 },
  "api.max_query_nodes": { min: 1 },
  "api.nested_write_max_depth": { min: 1, max: 3 },
  "api.nested_write_max_records": { min: 1 },

  "auth.password_min_length": { min: 8, max: 128 },
  "auth.session_ttl_hours": { min: 1 },
  "auth.session_idle_minutes": { min: 0, max: 10_080 },
  "auth.reauthentication_minutes": { min: 1, max: 1440 },
  "auth.dormant_account_days": { min: 0, max: 3650 },
  "auth.password_reset_ttl_minutes": { min: 1 },
  "auth.email_verification_ttl_hours": { min: 1 },
  "auth.invitation_ttl_hours": { min: 1 },
  "auth.max_sessions_per_user": { min: 1 },
  "auth.session_retention_days": { min: 0, max: 3650 },
  "auth.lockout_max_attempts": { min: 0, max: 100 },
  "auth.lockout_duration_minutes": { min: 1, max: 10_080 },

  "api_keys.default_ttl_days": { min: 1 },
  "api_keys.purge_after_days": { min: 0, max: 3650 },

  "security.rate_limit_per_minute": { min: 1 },
  "security.rate_limit_sign_in_per_minute": { min: 1, max: 1000 },
  "auth.access_review_interval_days": { min: 0, max: 3650 },

  "files.max_file_size_bytes": { min: 1 },
  "files.transforms.max_width": { min: 1 },
  "files.transforms.max_height": { min: 1 },
  "files.transforms.max_pixels": { min: 1 },
  "files.transforms.max_concurrent": { min: 1 },
  "files.transforms.timeout_ms": { min: 100 },
  "files.transforms.max_operations": { min: 1 },

  "idempotency.ttl_hours": { min: 1 },
  "transactions.max_operations": { min: 1 },
  "transactions.timeout_ms": { min: 0, max: 600_000 },

  "async_executions.stale_timeout_ms": { min: 1000 },
  "async_executions.poll_interval_ms": { min: 100 },
  "async_executions.retention_days": { min: 0, max: 3650 },
  "outbox.retention_days": { min: 1, max: 3650 },
  "outbox.max_attempts": { min: 1, max: 100 },
  "outbox.retry_delay_seconds": { min: 1 },
  "outbox.lease_seconds": { min: 30 },

  "smtp.port": { min: 1, max: 65_535 },
  "backups.keep": { min: 1, max: 365 },

  "sql_console.max_rows": { min: 1, max: 100_000 },
  "mcp.rate_limit_per_minute": { min: 1, max: 100_000 },
  "catalog.watch_interval_seconds": { min: 0, max: 3600 },
  "catalog.refresh_interval_minutes": { min: 0, max: 1440 },
  "pool.max": { min: 2, max: 1000 },
  "pool.idle_timeout_ms": { min: 1000 },
  "pool.connection_timeout_ms": { min: 100 },
  "pool.max_lifetime_ms": { min: 0 },

  "dataviews.export_max_rows": { min: 1 },
  "dataviews.print_max_rows": { min: 1 },
  "dataviews.map_max_points": { min: 1 },
  "dataviews.kanban_max_cards": { min: 1 },
  "dataviews.calendar_max_events": { min: 1 },
  "dataviews.gantt_max_bars": { min: 1 },
  "dataviews.tree_max_nodes": { min: 1 },
  "dataviews.save_max_operations": { min: 1 },
  "dataviews.bulk_edit_max_rows": { min: 1, max: 100 },

  "dashboards.query_timeout_ms": { min: 100 },
  "dashboards.query_max_rows": { min: 1 },
  "dashboards.max_concurrent_queries": { min: 1, max: 20 },
  "dashboards.cache_seconds": { min: 0, max: 86_400 },
  "dashboards.embed_max_ttl_minutes": { min: 1, max: 1440 },

  "workflows.max_sync_wait_ms": { min: 1000 },
  "workflows.max_run_duration_ms": { min: 1000 },
  "workflows.max_operations_per_run": { min: 1 },
  "workflows.max_iteration_items": { min: 1 },
  "workflows.max_runtime_value_bytes": { min: 1024 },
  "workflows.max_history_payload_bytes": { min: 0 },
  "workflows.max_chain_depth": { min: 1, max: 32 },
  "workflows.http_max_request_bytes": { min: 1024, max: 52_428_800 },
  "workflows.http_max_response_bytes": { min: 1024, max: 52_428_800 },
};

/** A numeric setting's effective range - its SETTINGS_BOUNDS entry, or whole numbers >= 0. */
export function settingBounds(key: SettingKey): SettingBounds {
  return SETTINGS_BOUNDS[key] ?? { min: 0 };
}
