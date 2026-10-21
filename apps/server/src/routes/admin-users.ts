import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import {
  assertPasswordStrength,
  hashPassword,
  type LinkDelivery,
  type UserSearchFilter,
  type UserStatus,
} from "@totalbase/auth";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { isUuid } from "./user-filter.js";
import { removeDeletedUserAvatar, removeUserAvatar, uploadUserAvatar, useProviderAvatar } from "../user-avatars.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import { LINK_DELIVERY_BODY, listEnvelope, USERS_SCHEMAS } from "../openapi-admin-docs-users.js";

const ID_PARAM = { id: { ...UUID_PARAM, description: "The user's id." } };

/** See Administration.md §1 (Users, Roles). */
export function registerAdminUsersRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  // Without `limit`, every user. With it, one page filtered in PostgreSQL -
  // ?q= (name/email), ?status=, ?role=, ?ids= (batch lookup), ?active=,
  // ?limit= (1-200), ?offset=. Either way meta.total for the pager.
  app.get<{ Querystring: UserListQuery }>("/admin/api/users", {
    preHandler,
    ...adminDoc("users", {
      summary: "List users",
      description:
        "Newest first. Without `limit`, every user (the filters need `limit`). With `limit`, one page filtered in " +
        "PostgreSQL. `meta.total` is the count matching the filters.",
      parameters: [
        { name: "limit", in: "query", description: "Page size (1-200). Enables paging and the other filters.", schema: { type: "integer", minimum: 1, maximum: 200 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        { name: "q", in: "query", description: "Case-insensitive substring of the name or email.", schema: { type: "string" } },
        { name: "status", in: "query", description: "INVITED = active, can sign in, no password yet; INACTIVE = deactivated; ACTIVE = the rest.", schema: { type: "string", enum: ["ACTIVE", "INVITED", "INACTIVE"] } },
        { name: "role", in: "query", description: "Only users holding this role id.", schema: UUID },
        { name: "ids", in: "query", description: "Comma-separated user ids (at most 200) - a batch lookup.", schema: { type: "string" } },
        { name: "active", in: "query", description: "`true` = only active accounts (`false` applies no filter).", schema: { type: "string", enum: ["true", "false"] } },
        { name: "extra[<column>]", in: "query", description: "A column the project added to users equal to this value (its text); empty = no value. Several AND together.", schema: { type: "string" } },
      ],
      response: {
        status: "200",
        schema: listEnvelope(arrayOf(ref("UsersListItem")), object({ total: { type: "integer" } }, ["total"]), true),
      },
      schemas: USERS_SCHEMAS,
    }),
  }, async (request) => {
    if (request.query.limit === undefined) {
      const users = await context.auth.users.listForAdmin();
      return { data: users, meta: { total: users.length } };
    }
    const filter = parseUserListQuery(request.query);
    // ?extra[<column>]=<value> - a column the project added (empty: no value); any other is refused.
    const extra = extraFilters(request.query as Record<string, unknown>);
    if (extra.length > 0) {
      const columns = await context.auth.users.projectColumns();
      for (const { column } of extra) {
        if (!columns.includes(column)) throw new TotalBaseError("INVALID_QUERY", `${column} is not a column the project added to the users table.`);
      }
      filter.extra = extra;
    }
    const { users, total } = await context.auth.users.searchForAdmin(filter);
    return { data: users, meta: { total } };
  });

  // The columns a project added to users (AGENTS.md §11) - the Users screen's Additional data, the list's filters.
  app.get("/admin/api/users/project-columns", {
    preHandler,
    ...adminDoc("users", {
      summary: "The columns a project added to the users table",
      description: "Every column of totalbase.users that isn't TotalBase's own, in table order - read and written as any column, through the Data API.",
      response: ok(arrayOf(object({ name: { type: "string" } }, ["name"]))),
    }),
  }, async () => ({ data: (await context.auth.users.projectColumns()).map((name) => ({ name })) }));

  // The Users panel's counts without fetching a single row: users (all /
  // per status / per role), plus the credentials still in use - tokens
  // that authenticate, live sessions.
  app.get("/admin/api/users/summary", {
    preHandler,
    ...adminDoc("users", {
      summary: "User and credential counts",
      description: "Counts per status and per role, plus personal access tokens and sessions still in use - without fetching any row.",
      response: ok(ref("UsersSummary")),
      schemas: USERS_SCHEMAS,
    }),
  }, async () => ({
    data: {
      ...(await context.auth.users.summaryForAdmin()),
      credentials: {
        tokens: await context.usersApis.countUsable(),
        sessions: await context.auth.sessions.countActive(),
      },
    },
  }));

  app.post<{ Body: { data?: { email: string; name?: string; password?: string; roleIds?: unknown } } | undefined }>(
    "/admin/api/users",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Create a user",
        description:
          "With `password`, a complete account ready to sign in (its email counts as verified). Without it, a passwordless " +
          "account that becomes usable once POST /admin/api/users/{id}/invite lets the person set their own password. " +
          "The account and its roles are created in one transaction; a duplicate email (case-insensitive) is 409 UNIQUE_VIOLATION.",
        requestBody: {
          schema: dataEnvelope(object({
            email: { type: "string", format: "email" },
            name: { type: "string", maxLength: 200 },
            password: { type: "string", description: "Must meet auth.password_min_length." },
            roleIds: { ...arrayOf(UUID), description: "Role ids to assign." },
          }, ["email"])),
        },
        response: { status: "201", schema: dataEnvelope(ref("UsersListItem")) },
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const body = request.body?.data;
      if (!body) throw new TotalBaseError("INVALID_QUERY", "A request body { data } is required.");
      const roles = body.roleIds === undefined ? [] : parseRoleIds(body.roleIds);
      // A password provisions a complete, ready-to-log-in account (the
      // "New user" flow) - distinct from the passwordless account created
      // by leaving it out, which only becomes usable once "Send invite"
      // (POST /:id/invite) lets the person set their own password.
      let passwordHash: string | null = null;
      if (body.password) {
        const minLength = await context.settings.get("auth.password_min_length");
        assertPasswordStrength(body.password, minLength);
        passwordHash = await hashPassword(body.password);
      }
      // One transaction: the account, its verified email and its roles
      // exist together or not at all. A duplicate email is PostgreSQL's
      // own unique index on lower(email) - no pre-check (AGENTS.md 16).
      const user = await context.database.transaction(async (client) => {
        // An admin setting the password directly is vouching for the
        // account themselves - there's no verification link to click for
        // an address only they (not the new user) just typed in.
        const created = await context.auth.users.create(
          { email: body.email, name: body.name ?? null, passwordHash, emailVerified: passwordHash !== null },
          client,
        );
        if (roles.length > 0) await context.roleAssignments.setRolesForUser(created.id, roles, client);
        return created;
      });
      // The same shape GET /admin/api/users/{id} returns.
      const withState = await context.auth.users.findForAdmin(user.id);
      request.auditMetadata = { user_id: user.id, roles_added: roles, roles_removed: [] };
      reply.code(201);
      return { data: withState };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/users/:id",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Get a user",
        pathParameters: ID_PARAM,
        response: ok(ref("UsersListItem")),
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request) => {
      const user = await context.auth.users.findForAdmin(request.params.id);
      if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      return { data: user };
    },
  );

  // An admin sets a user's password (AuthService.adminSetPassword). Their
  // own account needs the current password and keeps their session.
  app.put<{ Params: { id: string }; Body: { data?: { password?: string; currentPassword?: string; signOut?: boolean } } | undefined }>(
    "/admin/api/users/:id/password",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Set a user's password",
        description:
          "Changing your own password requires `currentPassword` and keeps your current session. `signOut` (default true) " +
          "revokes the user's other sessions.",
        pathParameters: ID_PARAM,
        requestBody: {
          schema: dataEnvelope(object({
            password: { type: "string", description: "Must meet auth.password_min_length." },
            currentPassword: { type: "string", description: "Required when the target is the caller's own account." },
            signOut: { type: "boolean", default: true },
          }, ["password"])),
        },
        response: NO_CONTENT,
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const body = request.body?.data;
      const self = request.admin!.id === request.params.id;
      if (self && typeof body?.currentPassword !== "string") {
        throw new TotalBaseError("INVALID_CURRENT_PASSWORD", "Enter your current password to change it.");
      }
      if (body?.signOut !== undefined && typeof body.signOut !== "boolean") {
        throw new TotalBaseError("INVALID_QUERY", "signOut must be true or false.");
      }
      await context.auth.adminSetPassword({
        userId: request.params.id,
        password: body?.password as string,
        signOut: body?.signOut ?? true,
        currentPassword: self ? body!.currentPassword : undefined,
        keepSessionId: self ? request.adminSession : undefined,
      });
      request.auditMetadata = { user_id: request.params.id, sign_out: body?.signOut ?? true, self };
      reply.code(204);
    },
  );

  // Changing the sign-in email: the admin decides whether the new
  // address counts as verified or gets a verification email. The change
  // commits either way; a verification email that can't be sent (no SMTP)
  // is reported back, not rolled back.
  app.put<{ Params: { id: string }; Body: { data?: { email?: string; verification?: "SEND" | "VERIFIED" } } | undefined }>(
    "/admin/api/users/:id/email",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Change a user's email",
        description:
          "`verification`: `VERIFIED` marks the new address verified now; `SEND` leaves it unverified and emails a " +
          "verification link. A real change retires the user's unused invitation/reset/verification links and notifies " +
          "the previous address. The change commits even when the verification email can't be sent - `meta.verificationError` " +
          "then says why. A duplicate email is 409 UNIQUE_VIOLATION.",
        pathParameters: ID_PARAM,
        requestBody: {
          schema: dataEnvelope(object({
            email: { type: "string", format: "email" },
            verification: { type: "string", enum: ["SEND", "VERIFIED"] },
          }, ["email", "verification"])),
        },
        response: {
          status: "200",
          schema: listEnvelope(ref("UsersListItem"), object({
            verificationSent: { type: "boolean" },
            verificationError: { type: "string", description: "Present when `SEND` was asked but the email couldn't be sent." },
          }, ["verificationSent"])),
        },
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request) => {
      const body = request.body?.data;
      const verification = body?.verification;
      if (verification !== "SEND" && verification !== "VERIFIED") {
        throw new TotalBaseError("INVALID_QUERY", 'verification must be "SEND" or "VERIFIED".');
      }
      if (typeof body?.email !== "string") throw new TotalBaseError("INVALID_QUERY", "email is required.");
      const { user, previousEmail, changed } = await context.auth.users.changeEmail(request.params.id, body.email, {
        verified: verification === "VERIFIED",
      });
      request.auditMetadata = { user_id: user.id, previous_email: previousEmail, email: user.email, verification };

      // The previous address hears about it (a security notice, best-effort).
      if (changed && previousEmail && user.canLogin && user.email) {
        await context.auth.notifyEmailChanged({ email: previousEmail, name: user.name }, user.email);
      }

      let verificationError: string | undefined;
      if (changed && verification === "SEND" && user.canLogin && user.email) {
        try {
          await context.auth.sendEmailVerification(user.id, user.email);
        } catch (err) {
          verificationError = err instanceof TotalBaseError ? err.message : "The verification email could not be sent.";
        }
      }
      const listed = await context.auth.users.findForAdmin(user.id);
      return { data: listed, meta: { verificationSent: changed && verification === "SEND" && !verificationError, ...(verificationError && { verificationError }) } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/api/users/:id",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Delete a user",
        description:
          "403 PERMISSION_DENIED for the caller's own account, the instance owner and the Workflows system user. " +
          "Also removes an uploaded avatar. 404 for an unknown id.",
        pathParameters: ID_PARAM,
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const avatarUrl = (await context.auth.users.findById(request.params.id))?.avatarUrl ?? null;
      const deleted = await context.auth.users.delete(request.params.id, request.admin!.id);
      if (!deleted) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      await removeDeletedUserAvatar(context, avatarUrl);
      reply.code(204);
    },
  );

  // Reset two-factor authentication (Security.md §2.17): a lost phone - the factor and its recovery codes
  // go, and the user sets it up again (at once, when the instance requires it).
  app.delete<{ Params: { id: string } }>(
    "/admin/api/users/:id/mfa",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Reset a user's two-factor authentication",
        description:
          "Removes the user's authenticator app and recovery codes; their sessions stay. 404 for an unknown user, " +
          "409 MFA_NOT_ENABLED when it isn't on.",
        pathParameters: ID_PARAM,
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      if (!(await context.auth.users.findById(request.params.id))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      if (!(await context.auth.mfa.reset(request.params.id))) {
        throw new TotalBaseError("MFA_NOT_ENABLED", "Two-factor authentication isn't on for this user.");
      }
      request.auditMetadata = { user_id: request.params.id };
      reply.code(204);
    },
  );

  // Avatar (user-avatars.ts): upload an image (multipart "file"), take the
  // sign-in provider's picture, or remove it. Applied at once.
  app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1 } }); // user-avatars.ts enforces the real limit
    scoped.post<{ Params: { id: string } }>("/admin/api/users/:id/avatar", {
      preHandler,
      ...adminDoc("users", {
        summary: "Upload a user's avatar",
        description: "A PNG, JPEG or WebP image in the multipart field `file`; replaces the current avatar at once.",
        pathParameters: ID_PARAM,
        requestBody: {
          contentType: "multipart/form-data",
          schema: object({ file: { type: "string", format: "binary" } }, ["file"]),
        },
        response: ok(ref("UsersAvatar")),
        schemas: USERS_SCHEMAS,
      }),
    }, async (request) => {
      const file = await request.file();
      if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
      const avatarUrl = await uploadUserAvatar(context, request.params.id, await file.toBuffer(), request.admin!.id);
      request.auditMetadata = { user_id: request.params.id, source: "upload" };
      return { data: { avatarUrl } };
    });
  });

  app.post<{ Params: { id: string } }>("/admin/api/users/:id/avatar/provider", {
    preHandler,
    ...adminDoc("users", {
      summary: "Use the sign-in provider's picture as avatar",
      description: "Takes the user's `providerAvatar`; 404 when the user has none.",
      pathParameters: ID_PARAM,
      response: ok(ref("UsersAvatar")),
      schemas: USERS_SCHEMAS,
    }),
  }, async (request) => {
    const avatarUrl = await useProviderAvatar(context, request.params.id);
    request.auditMetadata = { user_id: request.params.id, source: "provider" };
    return { data: { avatarUrl } };
  });

  app.delete<{ Params: { id: string } }>("/admin/api/users/:id/avatar", {
    preHandler,
    ...adminDoc("users", { summary: "Remove a user's avatar", pathParameters: ID_PARAM, response: NO_CONTENT }),
  }, async (request, reply) => {
    await removeUserAvatar(context, request.params.id);
    request.auditMetadata = { user_id: request.params.id };
    reply.code(204);
  });

  // Invite / password reset: `delivery: "email"` (default) sends the
  // system email; `delivery: "link"` sends nothing and returns the
  // single-use link for the admin to share another way (e.g. while SMTP
  // isn't configured). Either way any earlier link of the same kind stops
  // working. A delivery failure is reported (SMTP_NOT_CONFIGURED /
  // EMAIL_SEND_FAILED), unlike the public forgot-password route.
  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery } } | undefined }>(
    "/admin/api/users/:id/invite",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Send an invitation",
        description:
          "Issues a single-use link to set a password (any earlier invitation link stops working). With `delivery: \"email\"` " +
          "a delivery failure is reported: 409 SMTP_NOT_CONFIGURED or 502 EMAIL_SEND_FAILED.",
        pathParameters: ID_PARAM,
        requestBody: { schema: dataEnvelope(LINK_DELIVERY_BODY), required: false },
        response: ok(ref("UsersLinkDelivery")),
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request) => {
      const delivery = parseDelivery(request.body?.data?.delivery);
      const user = await context.auth.users.findById(request.params.id);
      if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      if (!user.email) {
        throw new TotalBaseError("INVALID_QUERY", "User has no email to invite.");
      }
      const actionUrl = await context.auth.createInvitation({ id: user.id, email: user.email, name: user.name }, delivery);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );

  app.post<{ Params: { id: string }; Body: { data?: { delivery?: LinkDelivery } } | undefined }>(
    "/admin/api/users/:id/reset-password",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Send a password reset",
        description:
          "Issues a single-use password reset link (any earlier one stops working). With `delivery: \"email\"` a delivery " +
          "failure is reported: 409 SMTP_NOT_CONFIGURED or 502 EMAIL_SEND_FAILED.",
        pathParameters: ID_PARAM,
        requestBody: { schema: dataEnvelope(LINK_DELIVERY_BODY), required: false },
        response: ok(ref("UsersLinkDelivery")),
        schemas: USERS_SCHEMAS,
      }),
    },
    async (request) => {
      const delivery = parseDelivery(request.body?.data?.delivery);
      const user = await context.auth.users.findById(request.params.id);
      if (!user?.email) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      const actionUrl = await context.auth.sendPasswordReset({ id: user.id, email: user.email, name: user.name }, delivery);
      return { data: delivery === "link" ? { delivered: false, actionUrl } : { delivered: true } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/users/:id/roles",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "A user's role ids",
        description: "The roles assigned directly to the user. 404 for an unknown user.",
        pathParameters: ID_PARAM,
        response: ok(arrayOf(UUID)),
      }),
    },
    async (request) => {
      if (!(await context.auth.users.findById(request.params.id))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      const roleIds = await context.roleAssignments.listRolesForUser(request.params.id);
      return { data: roleIds };
    },
  );

  app.put<{ Params: { id: string }; Body: { data?: { roleIds?: unknown } } | undefined }>(
    "/admin/api/users/:id/roles",
    {
      preHandler,
      ...adminDoc("users", {
        summary: "Replace a user's roles",
        description:
          "Sets the complete list of role ids (roles left out are removed). The instance owner can't lose the " +
          "Administrators role (403).",
        pathParameters: ID_PARAM,
        requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf(UUID) }, ["roleIds"])) },
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const roles = parseRoleIds(request.body?.data?.roleIds);
      const user = await context.auth.users.findById(request.params.id);
      if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
      if (user.owner) {
        const administratorsRoleId = await context.roles.getAdministratorsRoleId();
        if (!roles.includes(administratorsRoleId)) {
          throw new TotalBaseError("PERMISSION_DENIED", "The instance owner cannot lose the Administrators role.");
        }
      }
      const before = await context.roleAssignments.listRolesForUser(request.params.id);
      await context.roleAssignments.setRolesForUser(request.params.id, roles);
      // The access review reads these (GET /audit/logs?role_change=<role>).
      request.auditMetadata = {
        user_id: request.params.id,
        roles_added: roles.filter((id) => !before.includes(id)),
        roles_removed: before.filter((id) => !roles.includes(id)),
      };
      reply.code(204);
    },
  );
}

function parseDelivery(value: unknown): LinkDelivery {
  if (value === undefined || value === "email") return "email";
  if (value === "link") return "link";
  throw new TotalBaseError("INVALID_QUERY", 'delivery must be "email" or "link".');
}

/** A role id list from a request body - an array of UUIDs, or a 400. */
function parseRoleIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isUuid)) {
    throw new TotalBaseError("INVALID_QUERY", "roleIds must be an array of role ids.");
  }
  return value as string[];
}

interface UserListQuery {
  q?: string;
  status?: string;
  role?: string;
  /** Comma-separated user ids (at most MAX_PAGE_SIZE). */
  ids?: string;
  active?: string;
  limit?: string;
  offset?: string;
}

const USER_STATUSES: readonly UserStatus[] = ["ACTIVE", "INVITED", "INACTIVE"];
const MAX_PAGE_SIZE = 200;

/** `?extra[<column>]=<value>` - nested by the query parser (`extra: { column: value }`) or flat; empty = no value. */
function extraFilters(query: Record<string, unknown>): { column: string; value: string | null }[] {
  const pairs: [string, unknown][] = [];
  if (query["extra"] !== null && typeof query["extra"] === "object") pairs.push(...Object.entries(query["extra"] as Record<string, unknown>));
  for (const [key, value] of Object.entries(query)) {
    const match = /^extra\[(.+)\]$/.exec(key);
    if (match) pairs.push([match[1]!, value]);
  }
  return pairs.map(([column, value]) => {
    const text = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
    return { column, value: text === "" ? null : text };
  });
}

function parseUserListQuery(query: UserListQuery): UserSearchFilter {
  const limit = Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new TotalBaseError("INVALID_QUERY", `limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new TotalBaseError("INVALID_QUERY", "offset must be 0 or more.");
  if (query.status !== undefined && !(USER_STATUSES as readonly string[]).includes(query.status)) {
    throw new TotalBaseError("INVALID_QUERY", "status must be ACTIVE, INVITED or INACTIVE.");
  }
  if (query.role !== undefined && !isUuid(query.role)) throw new TotalBaseError("INVALID_QUERY", "role must be a role id.");
  const ids = query.ids === undefined ? undefined : query.ids.split(",").filter(Boolean);
  if (ids && (ids.length > MAX_PAGE_SIZE || !ids.every(isUuid))) {
    throw new TotalBaseError("INVALID_QUERY", `ids must be at most ${MAX_PAGE_SIZE} comma-separated user ids.`);
  }
  if (query.active !== undefined && query.active !== "true" && query.active !== "false") {
    throw new TotalBaseError("INVALID_QUERY", "active must be true or false.");
  }
  return {
    q: query.q,
    status: query.status as UserStatus | undefined,
    role: query.role,
    ids,
    active: query.active === "true",
    limit,
    offset,
  };
}
