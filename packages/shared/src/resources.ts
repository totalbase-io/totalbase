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
