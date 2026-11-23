import { TotalBaseError } from "@totalbase/errors";
import type { ResourceAction } from "@totalbase/permissions";
import type { DataPrincipal } from "./context.js";
import type { Limits } from "./mutation-service.js";
import { assertColumnsGranted, resolveTableGrant, rowFilterLimits, rowPassesGrant, type TableAuthorizationContext } from "./table-row-authorization.js";

/**
 * Authorization for the Files feature, resolved through the exact same
 * totalbase.permissions + EffectivePermissionService model as any
 * other resource (table-row-authorization.ts): `totalbase.files`
 * has its own real totalbase.resources row, so there is no
 * files-specific permission table - one engine for every table. Used by
 * apps/server's Files routes and by the workflow file operations
 * (Workflows.md §5.20), so both apply one rule.
 */

/**
 * A new file under the CREATE grant on files, as any other row is (Security.md §6.6, Administration.md §10.3): the
 * action, a field grant for each column the caller sets (`visibility`, `folder`, `description`, `tags`), and the
 * grant's row filter on the file as made - one it doesn't pass is removed again and the upload refused. `create`
 * stores it, `remove` takes it back.
 */
export async function createFileAuthorized<T extends { id: string }>(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  columns: string[],
  create: () => Promise<T>,
  remove: (id: string) => Promise<unknown>,
): Promise<T> {
  const grant = await resolveTableGrant(context, dataPrincipal, "files", "CREATE", "FILE_ACCESS_DENIED");
  assertColumnsGranted(grant, columns, "FILE_ACCESS_DENIED");
  const record = await create();
  if (!(await rowPassesGrant(context.database, context, dataPrincipal, grant, record.id, await rowFilterLimits(context)))) {
    await remove(record.id).catch(() => undefined);
    throw new TotalBaseError("FILE_ACCESS_DENIED", "The file would not satisfy your permission's row filter for CREATE.");
  }
  return record;
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

/**
 * Who may set a file's visibility (Administration.md §10.6): an administrator, or whoever uploaded the file - and
 * Public only while `files.uploader_can_publish` is on. Everyone else who reaches a file sees it, but never decides who
 * else does. `uploader` is the file's `created_by` (a new file's is the caller).
 */
export async function assertVisibilityAllowed(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  visibility: string,
  uploader: string | null,
): Promise<void> {
  if (await context.effectivePermissions.isAdministrators(dataPrincipal.roleIds)) return;
  const actor = dataPrincipal.actorUserId ?? (dataPrincipal.userRow?.["id"] as string | undefined) ?? null;
  if (actor === null || uploader !== actor) {
    throw new TotalBaseError("FILE_ACCESS_DENIED", "Only whoever uploaded a file, or an administrator, may change its visibility.");
  }
  if (visibility === "PUBLIC" && !(await context.settings.get("files.uploader_can_publish"))) {
    throw new TotalBaseError("FILE_ACCESS_DENIED", "Only an administrator may make a file public (files.uploader_can_publish is off).");
  }
}
