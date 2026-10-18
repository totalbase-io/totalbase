/**
 * The one seeded system role + user that every workflow's `execute_as`
 * defaults to - full data-permission bypass
 * (`admin_access`) by design, but `can_login = false` so the account
 * can never itself authenticate a session. Both the app-level guards
 * (packages/permissions' RoleAssignmentsService, packages/auth's
 * UsersService) and the DB-level lockdown triggers
 * key off these same two constants, so there is exactly one place that
 * defines "which role/user this is" - not two independently hardcoded
 * literals that could drift apart.
 */
export const WORKFLOWS_ROLE_NAME = "Workflows";
export const WORKFLOWS_SYSTEM_USER_EMAIL = "workflows@system.totalbase.internal";
