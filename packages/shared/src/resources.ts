/** TotalBase's own schema - its tables are the system's (Security.md §10.1). */
export const TOTALBASE_SCHEMA = "totalbase";

/**
 * Whether a resource's Data API exposure is fixed by TotalBase: its own tables' is (a fixed exposure set, access
 * decided by grants alone - Security.md §10.1); an application resource's an administrator chooses.
 * The one rule for the server (what reconcile writes, what a resource reports as `exposureFixed`) and the admin
 * (a resource read as a plain `resources` row through the Data API).
 */
export function isExposureFixed(schema: string): boolean {
  return schema === TOTALBASE_SCHEMA;
}

/** A Data API method a resource can expose - the HTTP verbs, and a table's realtime subscriptions (Data_API.md §16). */
export type DataApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "REALTIME";

/**
 * What the Data API offers per resource type (Foundations.md §11.5) - the ceiling `exposed_methods` can select
 * from. The server's rule and the admin's Endpoints switches, one list.
 */
export const APPLICABLE_METHODS: Record<"TABLE" | "VIEW" | "FUNCTION", DataApiMethod[]> = {
  TABLE: ["GET", "POST", "PATCH", "DELETE", "REALTIME"],
  VIEW: ["GET"],
  FUNCTION: ["POST"],
};
