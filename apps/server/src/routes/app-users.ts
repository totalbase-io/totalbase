import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LinkDelivery } from "@totalbase/auth";
import { checkConstraintValues } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { assertColumnsGranted, assertRolesAssignable, resolveTableGrant, rowFilterLimits, rowPassesGrant } from "@totalbase/mutations";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { sourceDetail } from "../record-catalog.js";
import { removeDeletedUserAvatar } from "../user-avatars.js";

const DENIED = "ACTION_DENIED";

async function principalOf(context: AppContext, request: FastifyRequest): Promise<DataPrincipal> {
  return resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
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

/**
 * User actions for delegated users that are not a plain row write
 * (Security.md §9.3) - inviting someone, and sending an
 * existing user an invitation or password reset link - through the same
 * services as the Admin API, authorized like a Data API write. Listing,
 * editing and deleting users, and their role assignments, go through the
 * Data API itself.
 */
export function registerAppUsersRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  // The columns the project added to users that the caller may set when inviting (CREATE on the
  // table, each column granted) - the invite form's Additional data, with what shows each one: its type,
  // presentation, a foreign key's target and its row presentation, a CHECK list's values. Never a CHECK
  // expression, and nothing of a column the grant leaves out.
  app.get("/app/api/users/invitation-columns", { preHandler }, async (request) => {
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
  app.post<{ Body: { data?: { email?: string; name?: string | null; roles?: string[]; extra?: Record<string, unknown>; delivery?: LinkDelivery } } }>(
    "/app/api/users/invitations",
    { preHandler },
    async (request, reply) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const body = request.body?.data ?? {};
      const delivery = parseDelivery(body.delivery, administrator);
      const roles = [...new Set(Array.isArray(body.roles) ? body.roles : [])];
      if (roles.some((role) => typeof role !== "string")) throw new TotalBaseError("INVALID_QUERY", "roles must be an array of role ids.");
      // The columns the project added to the users table (Additional data), set on the new row before
      // the row filter is checked - a filter like branch = $USER.branch needs them there.
      const extra = body.extra ?? {};
      if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new TotalBaseError("INVALID_QUERY", "extra must be an object of column values.");

      const userGrant = await resolveTableGrant(context, principal, "users", "CREATE", DENIED);
      assertColumnsGranted(userGrant, [...(body.name ? ["email", "name"] : ["email"]), ...Object.keys(extra)], DENIED);
      const assignmentGrant = roles.length > 0
        ? await resolveTableGrant(context, principal, "users_roles", "CREATE", DENIED)
        : undefined;
      if (assignmentGrant) assertColumnsGranted(assignmentGrant, ["user", "role"], DENIED);
      const limits = await rowFilterLimits(context);

      const user = await context.database.transaction(async (client) => {
        const created = await context.auth.users.create({ email: body.email ?? null, name: body.name ?? null }, client);
        await context.auth.users.setProjectColumns(created.id, extra, client);
        if (!(await rowPassesGrant(client, context, principal, userGrant, created.id, limits))) {
          throw new TotalBaseError(DENIED, "The user does not satisfy your permission's row filter.");
        }
        if (assignmentGrant) {
          // The Data API's own assignment guardrails (totalbase-guardrails.ts): never a reserved or
          // administrative role, and for a non-administrator only a role they created or one their roles manage.
          await assertRolesAssignable(client, roles, { administrator, actorUserId: principal.actorUserId, roleIds: principal.roleIds });
          await context.roleAssignments.setRolesForUser(created.id, roles, client);
          const { rows: assignments } = await client.query<{ id: string }>(`SELECT id FROM totalbase.users_roles WHERE "user" = $1`, [created.id]);
          for (const assignment of assignments) {
            if (!(await rowPassesGrant(client, context, principal, assignmentGrant, assignment.id, limits))) {
              throw new TotalBaseError(DENIED, "A role assignment does not satisfy your permission's row filter.");
            }
          }
        }
        return created;
      }, { actorUserId: principal.actorUserId });

      request.auditMetadata = { user_id: user.id, roles_added: roles, roles_removed: [] };
      reply.code(201);
      const data = { id: user.id, email: user.email, name: user.name };
      // The account exists either way: a failed email (SMTP_NOT_CONFIGURED,
      // EMAIL_SEND_FAILED) is reported alongside it, to be resent later.
      try {
        const actionUrl = await context.auth.createInvitation({ id: user.id, email: user.email!, name: user.name }, delivery);
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
    const avatarUrl = (await context.auth.users.findById(request.params.id))?.avatarUrl ?? null;
    await context.database.transaction(async (client) => {
      if (!(await rowPassesGrant(client, context, principal, grant, request.params.id, limits))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      }
      // No row filter on the grant lets any id through it - the delete itself says whether there was one.
      if (!(await context.auth.users.delete(request.params.id, principal.actorUserId, client))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      }
    }, { actorUserId: principal.actorUserId });
    request.auditMetadata = { user_id: request.params.id };
    await removeDeletedUserAvatar(context, avatarUrl);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery } } | undefined }>(
    "/app/api/users/:id/invite",
    { preHandler },
    async (request) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const delivery = parseDelivery(request.body?.data?.delivery, administrator);
      const user = await userReachable(context, principal, administrator, request.params.id);
      const actionUrl = await context.auth.createInvitation(user, delivery);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );

  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery } } | undefined }>(
    "/app/api/users/:id/reset-password",
    { preHandler },
    async (request) => {
      const principal = await principalOf(context, request);
      const administrator = await context.roles.isAdministrator(principal.roleIds);
      const delivery = parseDelivery(request.body?.data?.delivery, administrator);
      const user = await userReachable(context, principal, administrator, request.params.id);
      const actionUrl = await context.auth.sendPasswordReset(user, delivery);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );
}
