import { TotalBaseError } from "@totalbase/errors";

/** A list route's `?limit` and `?offset`, as its query string carries them. */
export interface PageQuery {
  limit?: string;
  offset?: string;
}

/**
 * A page of a list (Data_API.md §2.5 - totals go in `meta`): `limit` between 1 and `max`, `offset` 0 or more, both
 * whole numbers - anything else is `400 INVALID_QUERY`, before a query runs. With no `limit`, the route's default;
 * with no default either, every match (`limit` undefined).
 */
export function pageOf(query: PageQuery, options: { max: number; defaultLimit: number }): { limit: number; offset: number };
export function pageOf(query: PageQuery, options: { max: number }): { limit: number | undefined; offset: number };
export function pageOf(query: PageQuery, options: { max: number; defaultLimit?: number }): { limit: number | undefined; offset: number } {
  const limit = query.limit === undefined || query.limit === "" ? options.defaultLimit : wholeNumber(query.limit);
  const offset = query.offset === undefined || query.offset === "" ? 0 : wholeNumber(query.offset);
  if (limit !== undefined && (limit === null || limit < 1 || limit > options.max)) {
    throw new TotalBaseError("INVALID_QUERY", `limit must be between 1 and ${options.max}.`);
  }
  if (offset === null) throw new TotalBaseError("INVALID_QUERY", "offset must be 0 or more.");
  return { limit, offset };
}

/** A non-negative whole number written in decimal digits, else null. */
function wholeNumber(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
