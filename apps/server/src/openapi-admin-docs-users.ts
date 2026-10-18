import type { JsonSchema } from "@totalbase/openapi";
import { arrayOf, DATE_TIME, object, ref, UUID } from "./openapi-admin-docs.js";

/**
 * Admin API `config.openapi` schemas for the identity/credentials area:
 * users, sessions, tokens, secrets, auth providers and system emails.
 * Each mirrors the service return type it names (component names are
 * area-prefixed so they can't collide with other areas' components).
 */

const STRING: JsonSchema = { type: "string" };
const NULLABLE_STRING: JsonSchema = { type: ["string", "null"] };
const NULLABLE_DATE_TIME: JsonSchema = { type: ["string", "null"], format: "date-time" };

/** `{ data, meta }` - `meta` optional unless `metaRequired`. */
export function listEnvelope(data: JsonSchema, meta: JsonSchema, metaRequired = false): JsonSchema {
  return { type: "object", required: metaRequired ? ["data", "meta"] : ["data"], properties: { data, meta } };
}

/** `data` of the invite / reset-password routes' body. */
export const LINK_DELIVERY_BODY: JsonSchema = object({
  delivery: {
    type: "string",
    enum: ["email", "link"],
    default: "email",
    description: "`email` sends the system email; `link` sends nothing and returns the single-use link to share another way.",
  },
});

export const USERS_SCHEMAS: Record<string, JsonSchema> = {
  /** UsersService's UserListItem. */
  UsersListItem: object({
    id: UUID,
    email: { type: "string", format: "email" },
    name: NULLABLE_STRING,
    avatarUrl: NULLABLE_STRING,
    active: { type: "boolean" },
    owner: { type: "boolean", description: "The instance owner: can't be deleted, deactivated or lose the Administrators role." },
    canLogin: { type: "boolean", description: "False for system accounts (e.g. the Workflows user) that never sign in." },
    emailVerifiedAt: NULLABLE_DATE_TIME,
    createdAt: DATE_TIME,
    roles: arrayOf(UUID),
    hasPassword: { type: "boolean", description: "False for an invited account that hasn't set a password yet." },
    lastLoginAt: NULLABLE_DATE_TIME,
    lockedUntil: { ...NULLABLE_DATE_TIME, description: "Sign-in refused until then (too many failed attempts); null when not locked." },
    failedLoginCount: { type: "integer", description: "Consecutive failed sign-ins since the last success, unlock or lockout." },
    providerAvatar: {
      type: ["object", "null"],
      description: "The picture of the user's most recently used sign-in provider identity, if any.",
      properties: { url: STRING, provider: { type: "string", description: "The provider's name." } },
    },
  }),
  UsersSummary: object({
    total: { type: "integer" },
    byStatus: object({ ACTIVE: { type: "integer" }, INVITED: { type: "integer" }, INACTIVE: { type: "integer" } }),
    byRole: { type: "object", description: "Members per role id (roles with no members are absent).", additionalProperties: { type: "integer" } },
    credentials: object({
      tokens: { type: "integer", description: "Personal access tokens that still authenticate (active, not revoked, not expired)." },
      sessions: { type: "integer", description: "Sessions still signed in (not revoked, not expired)." },
    }),
  }),
  UsersLinkDelivery: object({
    delivered: { type: "boolean", description: "True when the email was sent." },
    actionUrl: { type: "string", format: "uri", description: "Only with `delivery: \"link\"`: the single-use link." },
  }, ["delivered"]),
  UsersAvatar: object({ avatarUrl: STRING }),
};

export const SESSIONS_SCHEMAS: Record<string, JsonSchema> = {
  SessionsSession: object({
    id: UUID,
    user: UUID,
    ip: { ...NULLABLE_STRING, description: "Client IP address when signed in." },
    userAgent: NULLABLE_STRING,
    createdAt: DATE_TIME,
    lastSeenAt: DATE_TIME,
    expiresAt: DATE_TIME,
    revokedAt: NULLABLE_DATE_TIME,
    userEmail: { type: "string", description: "The user's email." },
    userName: { ...NULLABLE_STRING, description: "The user's name." },
    current: { type: "boolean", description: "The caller's own session." },
  }, ["id", "user", "ip", "userAgent", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "userEmail", "userName", "current"]),
};

export const TOKENS_SCHEMAS: Record<string, JsonSchema> = {
  /** UsersApisService's UserApi plus the one-time plaintext key. */
  TokensIssued: object({
    id: UUID,
    user: UUID,
    name: STRING,
    description: NULLABLE_STRING,
    plane: { type: "string", enum: ["API", "ADMIN"], description: "`API`: the Data API with the user's roles; `ADMIN`: the Admin API." },
    keyPrefix: { type: "string", description: "The visible start of the key, to recognize it later." },
    active: { type: "boolean" },
    expiresAt: NULLABLE_DATE_TIME,
    lastUsedAt: NULLABLE_DATE_TIME,
    rotatedAt: NULLABLE_DATE_TIME,
    previousExpiresAt: { ...NULLABLE_DATE_TIME, description: "Until when the secret replaced by the last regeneration still works (its grace window); null when it stopped at once." },
    revokedAt: NULLABLE_DATE_TIME,
    createdAt: DATE_TIME,
    key: { type: "string", description: "The plaintext token - returned only in this response, never again." },
  }),
};

export const SECRETS_SCHEMAS: Record<string, JsonSchema> = {
  SecretsMetadata: object({
    key: { type: "string", description: "Lowercase alphanumeric with `.`, `_` or `-` separators, at most 200 characters." },
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
  }),
};

const AUTH_PROVIDER_TYPE: JsonSchema = { type: "string", enum: ["GOOGLE", "GITHUB", "OIDC"] };

export const AUTH_PROVIDERS_SCHEMAS: Record<string, JsonSchema> = {
  AuthProvidersConfiguration: object({
    client_id: STRING,
    client_secret_key: { type: "string", description: "Key of an existing secret (/admin/api/secrets) holding the client secret - never the secret itself." },
    scopes: arrayOf(STRING),
    allowed_redirect_urls: {
      ...arrayOf({ type: "string" }),
      minItems: 1,
      description: "Where a login may return to after the callback; at least one.",
    },
    default_role_id: { type: ["string", "null"], format: "uuid", description: "Role given to a user created on their first login through this provider; null = none." },
    issuer: { type: "string", description: "OIDC only (required there): fetches {issuer}/.well-known/openid-configuration." },
  }, ["client_id", "client_secret_key", "allowed_redirect_urls"]),
  AuthProvidersProvider: object({
    id: UUID,
    type: AUTH_PROVIDER_TYPE,
    name: STRING,
    slug: { ...STRING, description: "The provider's route segment (/api/auth/oauth/{slug}): google, github, or an OIDC provider's name slugified." },
    enabled: { type: "boolean" },
    showOnSignIn: { type: "boolean", description: "Its button on the portal's sign-in page." },
    configuration: ref("AuthProvidersConfiguration"),
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
  }),
  AuthProvidersRedirectUri: object({
    slug: { type: "string", description: "The `{provider}` segment of /api/auth/oauth/{provider}: `google`, `github`, or the OIDC provider's slugified name." },
    redirectUri: { type: "string", format: "uri", description: "The callback URL to register in the provider's own console." },
  }),
};

export { AUTH_PROVIDER_TYPE };

const SYSTEM_EMAIL_SLOT: JsonSchema = {
  type: "string",
  enum: ["user_invitation", "password_reset", "email_verification", "password_changed", "email_changed", "user_welcome"],
};

const SYSTEM_EMAIL_FIELDS: Record<string, JsonSchema> = {
  slot: SYSTEM_EMAIL_SLOT,
  label: STRING,
  description: STRING,
  hasAction: { type: "boolean", description: "Carries a single-use link: the template must include {{action_url}}." },
  variables: { ...arrayOf(STRING), description: "The {{placeholders}} the template may use; any other is rejected." },
  overridden: { type: "boolean", description: "An edited template is stored (otherwise the built-in default is used)." },
  enabled: { type: ["boolean", "null"], description: "null = always sent when its flow runs; otherwise the current on/off setting." },
  enabledSetting: { type: ["string", "null"], description: "The settings key that switches this email on/off, if any." },
};

export const SYSTEM_EMAILS_SCHEMAS: Record<string, JsonSchema> = {
  SystemEmailsTemplate: object({
    subject: { type: "string", description: "One line." },
    html: { type: "string", description: "Content-only HTML; the sender wraps it in a fixed layout." },
    text: { type: "string", description: "Plain-text body. At least one of html/text must be non-empty." },
  }, ["subject", "html", "text"]),
  SystemEmailsItem: object(SYSTEM_EMAIL_FIELDS),
  SystemEmailsDetail: object({
    ...SYSTEM_EMAIL_FIELDS,
    template: ref("SystemEmailsTemplate"),
    defaultTemplate: ref("SystemEmailsTemplate"),
  }),
  SystemEmailsRendered: object({
    subject: STRING,
    html: { type: "string", description: "The complete HTML email (layout included); empty when the template has no HTML body." },
    text: STRING,
  }),
};

export { SYSTEM_EMAIL_SLOT };
