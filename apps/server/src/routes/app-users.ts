import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LinkDelivery } from "@totalbase/auth";
import { checkConstraintValues } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { assertColumnsGranted, inviteUser, removeUser, resolveTableGrant, rowFilterLimits, rowPassesGrant } from "@totalbase/mutations";
import { dataEnvelope, type JsonSchema } from "@totalbase/openapi";
import { object } from "../openapi-admin-docs.js";
import { invitationDetails, parseInvitationMessage } from "../invitation-email.js";
import type { AppContext } from "../context.js";
import { canOnTotalbaseResource } from "../openapi-docs.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { sourceDetail } from "../record-catalog.js";
import { removeDeletedUserAvatar } from "../user-avatars.js";
import { optionalData } from "../request-body.js";

const DENIED = "ACTION_DENIED";

async function principalOf(context: AppContext, request: FastifyRequest): Promise<DataPrincipal> {
  const principal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
  // These routes' access audit entries (user.invite, user.remove, ...) say who acted: nothing else on the request does.
  request.auditPrincipal ??= principal.principal;
  return principal;
}

/**
 * How a link is delivered. A non-administrator only ever emails it to the
 * account's own address - holding the link itself is holding the account.
 */
function parseDelivery(value: unknown, administrator: boolean): LinkDelivery {
  if (value === undefined || value === "email") return "email";
  if (value === "link") {
    if (!administrator) throw new TotalBaseError("PERMISSION_DENIED", "Only an administrator can copy a link instead of emailing it.");
    return "link";
  }
  throw new TotalBaseError("INVALID_QUERY", "delivery must be \"email\" or \"link\".");
}

/**
 * The user `id`, when the caller's UPDATE grant on users reaches
 * that row - sending them a link acts on their account. Never an
 * administrator's account, unless the caller is one (Security.md §10.2).
 */
async function userReachable(context: AppContext, principal: DataPrincipal, administrator: boolean, id: string) {
  const grant = await resolveTableGrant(context, principal, "users", "UPDATE", DENIED);
  const user = await context.auth.users.findById(id);
  if (!user || !(await rowPassesGrant(context.database, context, principal, grant, id, await rowFilterLimits(context)))) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
  }
  if (!administrator && (user.owner || await context.roles.isAdministrator(await context.roleAssignments.listRolesForUser(id)))) {
    throw new TotalBaseError("PERMISSION_DENIED", "An administrator's account can only be changed by an administrator.");
  }
  if (!user.email) throw new TotalBaseError("INVALID_QUERY", "User has no email.");
  return { id: user.id, email: user.email, name: user.name };
}

const DELIVERY_PROPERTY: Record<string, JsonSchema> = { delivery: { type: "string", enum: ["email", "link"], description: "`link` (administrators only) answers the link instead of emailing it." } };
const MESSAGE_PROPERTY: Record<string, JsonSchema> = { message: { type: "string", maxLength: 500, description: "Your own line for the invitation email, plain text - sent where the instance's Invitation template includes {{message}}." } };
const SENT_SCHEMA = object({ delivered: { type: "boolean" }, actionUrl: { type: "string", format: "uri", description: "With `delivery: \"link\"` only." } }, ["delivered"]);
const USERS_DOC = { tags: ["users"], access: "principal" as const };

/**
 * User actions that are not a plain row write (Security.md §9.3) - inviting someone, and sending an existing
 * user an invitation or password reset link - as built-in actions on `users` (Data_API.md §2.2), through the
 * same services as the Admin API, authorized like a Data API write: CREATE on users with each column and the
 * row filter on the new row; UPDATE on the row. On the Data API's surface, so an application with its own
 * frontend - a tenant's owner with a session, its backend with a token - reaches them with its own grants; the
 * portal's Users module calls the same routes. Listing, editing and deleting users, and their role assignments,
 * go through the Data API itself; the delete with its avatar's removal keeps its /app/api route.
 */
export function registerAppUsersRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  // The columns the project added to users that the caller may set when inviting (CREATE on the
  // table, each column granted) - the invite form's Additional data, with what shows each one: its type,
  // presentation, a foreign key's target and its row presentation, a CHECK list's values. Never a CHECK
  // expression, and nothing of a column the grant leaves out.
  app.get("/api/totalbase/table/users/invitations/columns", {
    config: {
      openapi: {
        ...USERS_DOC,
        summary: "The columns an invitation may set",
        description: "The columns your project added to users that the caller's CREATE grant lets an invitation set, each with its type, presentation, foreign-key target and CHECK list.",
        response: { status: "200", schema: dataEnvelope({ type: "array", items: { type: "object", properties: { name: { type: "string" }, dataType: { type: "string" }, nullable: { type: "boolean" }, presentation: { type: "object" }, relation: { type: ["object", "null"] }, values: { type: ["array", "null"], items: { type: "string" } } } } }) },
        visible: canOnTotalbaseResource(context, "users", "CREATE"),
      },
    },
  }, async (request) => {
    const principal = await principalOf(context, request);
    const users = (await context.resourcesAdmin.list({ schema: "totalbase", type: "TABLE" })).find((r) => r.name === "users");
    if (!users) return { data: [] };
    const project = await context.auth.users.projectColumns();
    let allowed = project;
    if (!(await context.roles.isAdministrator(principal.roleIds))) {
      const permission = await context.effectivePermissions.resolve(principal.roleIds, users.id, "CREATE");
      allowed = permission.action === "ALLOW" ? project.filter((name) => permission.fieldDecision(name) === "ALLOW") : [];
    }
    if (allowed.length === 0) return { data: [] };
    const [detail, presentations, resources] = await Promise.all([
      sourceDetail(context, users.id),
      context.resourcesAdmin.listColumns(users.id),
      context.resourcesAdmin.list(),
    ]);
    const expressions = detail.checkConstraints.map((check) => check.expression);
    return {
      data: allowed.map((name) => {
        const column = detail.columns.find((c) => c.name === name);
        const relation = detail.relations.find((r) => r.sourceColumn === name);
        const target = relation && resources.find((r) => r.schema === relation.targetSchema && r.name === relation.targetTable);
        return {
          name,
          dataType: column?.dataType ?? "text",
          nullable: column?.nullable ?? true,
          presentation: presentations.find((p) => p.columnName === name)?.presentation ?? {},
          relation: relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable, targetColumn: relation.targetColumn, rowPresentation: target?.rowPresentation ?? {} } : null,
          values: checkConstraintValues(name, expressions),
        };
      }),
    };
  });

  // Invite: the account (CREATE on users, its columns granted,
  // the row filter on the new row) and its roles (CREATE on
  // users_roles, only roles the caller may assign) in one
  // transaction; the email goes out after it commits.
  app.post<{ Body: { data?: { email?: string; name?: string | null; roles?: string[]; extra?: Record<string, unknown>; delivery?: LinkDelivery; message?: unknown } } }>(
    "/api/totalbase/table/users/invitations",
    {
      config: {
        openapi: {
          ...USERS_DOC,
          summary: "Create an account and invite it",
          description: "Creates the user (CREATE on users: each column granted, the row filter checked on the new row), assigns `roles` (CREATE on users_roles, each role one you may assign) and emails the invitation, in one transaction - `meta.delivered` says whether the email went out; the account exists either way. `extra` holds the columns your project added to users.",
          requestBody: { schema: dataEnvelope(object({ email: { type: "string", format: "email" }, name: { type: ["string", "null"] }, roles: { type: "array", items: { type: "string", format: "uuid" } }, extra: { type: "object", additionalProperties: true }, ...DELIVERY_PROPERTY, ...MESSAGE_PROPERTY }, ["email"])) },
          response: { status: "201", schema: object({ data: object({ id: { type: "string", format: "uuid" }, email: { type: "string" }, name: { type: ["string", "null"] } }), meta: SENT_SCHEMA }) },
          visible: canOnTotalbaseResource(context, "users", "CREATE"),
        },
      },
    },
    async (request, reply) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const body = optionalData(request.body);
      const delivery = parseDelivery(body.delivery, administrator);
      const message = parseInvitationMessage(body.message);
      const roles = [...new Set(Array.isArray(body.roles) ? body.roles : [])];
      if (roles.some((role) => typeof role !== "string")) throw new TotalBaseError("INVALID_QUERY", "roles must be an array of role ids.");
      // The columns the project added to the users table (Additional data), in the row's own INSERT - a filter like
      // branch = $USER.branch needs them there, and a BEFORE INSERT trigger reads them from NEW.
      const extra = body.extra ?? {};
      if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new TotalBaseError("INVALID_QUERY", "extra must be an object of column values.");

      const user = await inviteUser(
        { ...context, users: context.auth.users },
        principal,
        administrator,
        { email: body.email ?? null, name: body.name ?? null, roles, extra },
      );

      request.auditMetadata = { user_id: user.id, roles_added: roles, roles_removed: [] };
      reply.code(201);
      const data = { id: user.id, email: user.email, name: user.name };
      // The account exists either way: a failed email (SMTP_NOT_CONFIGURED,
      // EMAIL_SEND_FAILED) is reported alongside it, to be resent later.
      try {
        const details = await invitationDetails(context, principal.onBehalfOf ?? principal.actorUserId, user.id, message);
        const actionUrl = await context.auth.createInvitation({ id: user.id, email: user.email!, name: user.name }, delivery, details);
        return { data, meta: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
      } catch (error) {
        if (!(error instanceof TotalBaseError)) throw error;
        return { data, meta: { delivered: false, error: { code: error.code, message: error.message } } };
      }
    },
  );

  // Delete: a row delete with a side effect the Data API doesn't have - the
  // user's avatar leaves storage after the commit. DELETE on the row (the
  // grant and its row filter), the service's rules, and PostgreSQL's
  // (an administrator's account, the owner, your own,
  // 000110), in one transaction made on the caller's behalf.
  app.delete<{ Params: { id: string } }>("/app/api/users/:id", { preHandler }, async (request, reply) => {
    const principal = await principalOf(context, request);
    const grant = await resolveTableGrant(context, principal, "users", "DELETE", DENIED);
    const limits = await rowFilterLimits(context);
    const user = await context.auth.users.findById(request.params.id);
    await context.database.transaction(async (client) => {
      if (!(await rowPassesGrant(client, context, principal, grant, request.params.id, limits))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      }
      // No row filter on the grant lets any id through it - the delete itself says whether there was one.
      if (!(await context.auth.users.delete(request.params.id, principal.actorUserId, client))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      }
    }, { actorUserId: principal.actorUserId });
    // Who it was: the row is gone, and with it the name every other entry's user_id resolved to.
    request.auditMetadata = { user_id: request.params.id, email: user?.email ?? null, name: user?.name ?? null };
    await removeDeletedUserAvatar(context, user?.avatarUrl ?? null);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery; message?: unknown } } | undefined }>(
    "/api/totalbase/table/users/:id/invite",
    {
      config: {
        openapi: {
          ...USERS_DOC,
          summary: "Send a user an invitation",
          description: "A new single-use invitation link, emailed to the account's own address (UPDATE on that user's row; never an administrator's account unless you are one).",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          requestBody: { schema: dataEnvelope(object({ ...DELIVERY_PROPERTY, ...MESSAGE_PROPERTY }, [])), required: false },
          response: { status: "200", schema: dataEnvelope(SENT_SCHEMA) },
          visible: canOnTotalbaseResource(context, "users", "UPDATE"),
        },
      },
    },
    async (request) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const body = optionalData(request.body);
      const delivery = parseDelivery(body.delivery, administrator);
      const message = parseInvitationMessage(body.message);
      const user = await userReachable(context, principal, administrator, request.params.id);
      const details = await invitationDetails(context, principal.onBehalfOf ?? principal.actorUserId, user.id, message);
      const actionUrl = await context.auth.createInvitation(user, delivery, details);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );

  // Remove (Security.md §1.12): "no longer in the organization" - the row kept for the audit log, every way in
  // and every role taken away. UPDATE on the row, like the links above.
  app.post<{ Params: { id: string } }>(
    "/api/totalbase/table/users/:id/remove",
    {
      config: {
        openapi: {
          ...USERS_DOC,
          summary: "Remove a user",
          description: "Keeps the row - the audit log goes on naming them - and takes away every way in: the account is deactivated and its password, sessions, tokens, two-factor authentication, sign-in provider links, pending links and role assignments are gone (UPDATE on that user's row; never your own account, the instance owner, or an administrator's unless you are one). `POST .../users/{id}/invite` brings it back.",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          response: { status: "204" },
          visible: canOnTotalbaseResource(context, "users", "UPDATE"),
        },
      },
    },
    async (request, reply) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const removed = await removeUser({ ...context, users: context.auth.users }, { principal, administrator }, request.params.id);
      request.auditMetadata = { user_id: removed.id, email: removed.email, name: removed.name, roles_added: [], roles_removed: removed.rolesRemoved };
      reply.code(204);
    },
  );

  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery } } | undefined }>(
    "/api/totalbase/table/users/:id/reset-password",
    {
      config: {
        openapi: {
          ...USERS_DOC,
          summary: "Send a user a password reset",
          description: "A new single-use reset link, emailed to the account's own address (UPDATE on that user's row; never an administrator's account unless you are one).",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          requestBody: { schema: dataEnvelope(object(DELIVERY_PROPERTY)), required: false },
          response: { status: "200", schema: dataEnvelope(SENT_SCHEMA) },
          visible: canOnTotalbaseResource(context, "users", "UPDATE"),
        },
      },
    },
    async (request) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const delivery = parseDelivery(optionalData(request.body).delivery, administrator);
      const user = await userReachable(context, principal, administrator, request.params.id);
      const actionUrl = await context.auth.sendPasswordReset(user, delivery);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );
}
