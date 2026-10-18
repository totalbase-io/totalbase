import { UUID_PATTERN } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import type { AdminResource } from "@totalbase/resources";
import type { AppContext } from "./context.js";

const MAX_OID = 4294967295;

/**
 * A resource named by a path `{id}` (the catalog routes, DROP VIEW/FUNCTION):
 * its TotalBase resource id, or the object's numeric PostgreSQL OID - the
 * same rules on every such route. Anything else names nothing: 404, never a
 * PostgreSQL cast error.
 */
export async function resourceByPathId(context: AppContext, id: string): Promise<AdminResource> {
  if (UUID_PATTERN.test(id)) return context.resourcesAdmin.get(id);
  if (/^\d+$/.test(id) && Number(id) <= MAX_OID) return context.resourcesAdmin.getByOid(Number(id));
  throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${id}`);
}
