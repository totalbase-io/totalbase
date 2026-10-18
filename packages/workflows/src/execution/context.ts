import type { EmailSender } from "@totalbase/auth";
import { TotalBaseError } from "@totalbase/errors";
import type { FilesAdminService } from "@totalbase/files";
import type { DataPrincipal, MutationsContext } from "@totalbase/mutations";
import type { RoleAssignmentsService, WorkflowPermissionService } from "@totalbase/permissions";
import type { SqlConsoleService } from "@totalbase/sql-console";
import type { TemplatesAdminService } from "@totalbase/templates";
import type { WorkflowRunsService } from "../workflow-runs-service.js";
import type { WorkflowsAdminService } from "../workflows-admin-service.js";
import type { WorkflowRunOutcome } from "./engine.js";

/** The logging the engine does - warnings about skipped/failed admissions, and background failures. */
export interface WorkflowEngineLogger {
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

/**
 * What the workflow engine needs from the running instance - the narrow
 * slice of apps/server's AppContext it uses (AppContext satisfies it
 * structurally): everything a Data API write needs (its steps create,
 * update and delete records through @totalbase/mutations) plus the
 * services its operation types call.
 */
export interface WorkflowEngineContext extends MutationsContext {
  logger: WorkflowEngineLogger;
  workflowsAdmin: WorkflowsAdminService;
  workflowRuns: WorkflowRunsService;
  workflowPermissions: Pick<WorkflowPermissionService, "resolveInvoke">;
  roleAssignments: Pick<RoleAssignmentsService, "listEffectiveRolesForUser">;
  filesAdmin: Pick<FilesAdminService, "get" | "readContent" | "upload">;
  templatesAdmin: Pick<TemplatesAdminService, "get">;
  sqlConsole: Pick<SqlConsoleService, "execute">;
  emailSender: Pick<EmailSender, "send">;
  /** An HTTP request's secret headers (Specification_Workflows.md §5.15) - read at run time, never stored. */
  secrets: { decrypt(key: string): Promise<string> };
  /** `totalbase.execute-workflow`'s recursive call - indirected through the context (not imported by handlers.ts) to avoid a circular import: engine.ts already imports OPERATION_HANDLERS from handlers.ts. See execute-workflow.ts. */
  invokeSubWorkflow: (params: { callerPrincipal: DataPrincipal; callerWorkflowId: string; ancestry: string[]; targetWorkflowId: string; input: unknown }) => Promise<WorkflowRunOutcome>;
}

/**
 * Resolves a fixed `execute_as` user id (CRON/WEBHOOK/DATA_EVENT triggers
 * all configure one, never an authenticated bearer token) into the same
 * `DataPrincipal` shape a session resolves to - every operation handler
 * only knows how to check permissions against a `DataPrincipal`.
 * Revalidated fresh on every admission (Specification_Workflows.md §7.2: "the configured
 * execution user is revalidated at admission") rather than cached.
 */
export async function resolveDataPrincipalForConfiguredUser(
  context: Pick<WorkflowEngineContext, "database" | "roleAssignments">,
  userId: string,
): Promise<DataPrincipal> {
  const { rows } = await context.database.query<Record<string, unknown> & { active: boolean }>(
    `SELECT * FROM totalbase.users WHERE id = $1`,
    [userId],
  );
  const userRow = rows[0];
  if (!userRow || !userRow.active) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This workflow's configured \"execute as\" user no longer exists or is inactive.");
  }
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
  return { principal: { type: "USER", id: userId }, roleIds, userRow, actorUserId: userId };
}
