import type { JsonSchema, OpenApiViewer } from "@totalbase/openapi";
import type { ResourceAction } from "@totalbase/permissions";
import type { AppContext } from "./context.js";

/**
 * Shared pieces for the `config.openapi` docs routes declare (see
 * @totalbase/openapi's RouteDoc): component schemas for shapes several
 * routes return, and visibility checks that reuse the exact permission
 * services the routes themselves enforce with.
 */

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** packages/auth's User, as the auth routes return it. */
export const USER_SCHEMA: Record<string, JsonSchema> = {
  User: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      email: { type: ["string", "null"], format: "email" },
      name: { type: ["string", "null"] },
      avatarUrl: { type: ["string", "null"] },
      active: { type: "boolean" },
      owner: { type: "boolean" },
      canLogin: { type: "boolean" },
      emailVerifiedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
};
export const USER_REF = ref("User");

export const SESSION_SCHEMAS: Record<string, JsonSchema> = {
  ...USER_SCHEMA,
  Session: {
    type: "object",
    required: ["token", "user"],
    properties: {
      token: { type: "string", description: "Send as `Authorization: Bearer <token>`." },
      user: USER_REF,
    },
  },
};
export const SESSION_REF = ref("Session");

/** packages/users-apis' UserApi - a personal API token (the key itself is only ever returned once). */
export const TOKEN_SCHEMAS: Record<string, JsonSchema> = {
  ApiToken: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      user: { type: "string", format: "uuid" },
      name: { type: "string" },
      description: { type: ["string", "null"] },
      plane: { type: "string", enum: ["API", "ADMIN"] },
      keyPrefix: { type: "string" },
      active: { type: "boolean" },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      rotatedAt: { type: ["string", "null"], format: "date-time" },
      previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "Until when the secret replaced by the last regeneration still works." },
      revokedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  ApiTokenWithKey: {
    allOf: [ref("ApiToken"), { type: "object", required: ["key"], properties: { key: { type: "string", description: "The plain key - shown only in this response." } } }],
  },
};

/** packages/files' FileRecord. */
export const FILE_SCHEMAS: Record<string, JsonSchema> = {
  File: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      folder: { type: ["string", "null"] },
      name: { type: "string" },
      extension: { type: "string" },
      mime_type: { type: "string" },
      size_bytes: { type: "integer" },
      checksum: { type: ["string", "null"] },
      width: { type: ["integer", "null"] },
      height: { type: ["integer", "null"] },
      visibility: { type: "string", enum: ["PRIVATE", "PUBLIC"] },
      metadata: { type: "object", additionalProperties: true },
      description: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      created_by: { type: ["string", "null"], format: "uuid" },
      updated_by: { type: ["string", "null"], format: "uuid" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
};
export const FILE_REF = ref("File");

/**
 * Whether the viewer's roles hold `action` on one of TotalBase's own
 * `totalbase.*` resources (Files, Templates) - the same
 * EffectivePermissionService check @totalbase/mutations' files-/templates-authorization.ts run.
 * Row filters don't matter here: an ALLOW with any filter still means the
 * route exists for this viewer.
 */
export function canOnTotalbaseResource(context: AppContext, table: string, action: ResourceAction) {
  return async (viewer: OpenApiViewer): Promise<boolean> => {
    const { rows } = await context.database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = $1`,
      [table],
    );
    if (!rows[0]) return false;
    const permission = await context.effectivePermissions.resolve(viewer.roleIds, rows[0].id, action);
    return permission.action === "ALLOW";
  };
}
