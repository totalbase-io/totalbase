import { TotalBaseError } from "@totalbase/errors";

/**
 * A JSON request body: everything the client sends is in `data`
 * (Specification_Data_API.md §2.5). One reader for every route, so a
 * missing or malformed envelope answers the same way everywhere.
 */
export interface DataBody<T> {
  data?: T;
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);

/** The body's `data` object - 400 when the body, or its `data`, is missing or not an object. */
export function requestData<T extends object>(body: DataBody<T> | null | undefined): T {
  const data = body?.data;
  if (!isObject(data)) throw new TotalBaseError("INVALID_QUERY", 'The request body must be { "data": { ... } }.');
  return data as T;
}

/** For a body the route may go without: its `data`, or `{}` - the route's own validation reports what's missing. */
export function optionalData<T extends object>(body: { data?: T | Partial<T> } | null | undefined): Partial<T> {
  const data = body?.data;
  return (isObject(data) ? data : {}) as Partial<T>;
}

/** A `:version` path parameter: a positive integer (400 otherwise); a version that doesn't exist is the service's 404. */
/** The publisher's note on a publish body (Specification.md §13.3): trimmed, at most 128 characters, else null. */
export function publishNote(body: { data?: { note?: unknown } } | null | undefined): string | null {
  const raw = body?.data?.note;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new TotalBaseError("INVALID_QUERY", "note must be a string.");
  const note = raw.trim();
  if (note.length > 128) throw new TotalBaseError("INVALID_QUERY", "note must be at most 128 characters.");
  return note || null;
}

export function versionParam(raw: string): number {
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new TotalBaseError("INVALID_QUERY", `Invalid version number: ${raw}`);
  return Number(raw);
}
