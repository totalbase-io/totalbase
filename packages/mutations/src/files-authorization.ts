import { TotalBaseError } from "@totalbase/errors";
import type { ResourceAction } from "@totalbase/permissions";
import type { DataPrincipal } from "./context.js";
import type { Limits } from "./mutation-service.js";
import { resolveTableGrant, rowFilterLimits, rowPassesGrant, type TableAuthorizationContext } from "./table-row-authorization.js";

/**
 * Authorization for the Files feature, resolved through the exact same
 * totalbase.permissions + EffectivePermissionService model as any
 * other resource (table-row-authorization.ts): `totalbase.files`
 * has its own real totalbase.resources row, so there is no
 * files-specific permission table - one engine for every table. Used by
 * apps/server's Files routes and by the workflow file operations
 * (Workflows.md §5.20), so both apply one rule.
 */

/** CREATE has no row yet to scope a filter against - a plain action check. */
export async function assertFileCreateAllowed(context: TableAuthorizationContext, dataPrincipal: DataPrincipal): Promise<void> {
  await resolveTableGrant(context, dataPrincipal, "files", "CREATE", "FILE_ACCESS_DENIED");
}

/** Authorization for one already-identified file (the Files routes' READ/UPDATE/DELETE, all addressed by id). */
export async function assertFileActionAllowed(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  fileId: string,
  action: ResourceAction,
  limits: Limits,
): Promise<void> {
  const grant = await resolveTableGrant(context, dataPrincipal, "files", action, "FILE_ACCESS_DENIED");
  if (!(await rowPassesGrant(context.database, context, dataPrincipal, grant, fileId, limits))) {
    throw new TotalBaseError("FILE_ACCESS_DENIED", `${action} is not authorized for Files.`);
  }
}

/** Reading a file's content or metadata: a PUBLIC file needs no permission; any other needs READ within the grant's row filter. */
export async function assertFileReadAllowed(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  file: { id: string; visibility: string },
): Promise<void> {
  if (file.visibility === "PUBLIC") return;
  await assertFileActionAllowed(context, dataPrincipal, file.id, "READ", await rowFilterLimits(context));
}
