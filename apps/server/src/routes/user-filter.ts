import { isUuid } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";


export { isUuid };

/** The optional `?user=<id>` filter of the Admin API's per-user lists - absent, or a UUID (else a 400). */
export function parseUserFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isUuid(value)) throw new TotalBaseError("INVALID_QUERY", "user must be a user id.");
  return value;
}
