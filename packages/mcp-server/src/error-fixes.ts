/**
 * What fixes an error, by its code: every refusal an agent meets during a build says which tool
 * to reach for next, so it corrects the cause instead of retrying. Appended to the error's text by AdminApiError;
 * a code with no entry reads as before. Each names tools this server has (its test checks).
 */
export const ERROR_FIXES: Readonly<Record<string, string>> = {
  ACTION_DENIED: "grant_permission (or grant_permissions) the action on that table to the role; get_permissions shows what it has",
  FIELD_PERMISSION_DENIED: "grant_permission with that field in the role's fields; get_permissions shows them",
  FUNCTION_EXECUTION_DENIED: "grant_permission EXECUTE on the function to the role",
  PERMISSION_DENIED: "this token's user isn't an administrator - ask one, or use an administrator's token",
  RESOURCE_NOT_FOUND: "list_resources (tables, views, functions) or list_dataviews / list_dashboards / list_workflows for the right id or slug; a table must be exposed: expose_resource",
  ROW_NOT_FOUND: "query_records for the row's key - it may be filtered out by a row filter",
  DATAVIEW_NOT_FOUND: "list_dataviews for its id or slug",
  DASHBOARD_NOT_FOUND: "list_dashboards for its id or slug",
  WORKFLOW_NOT_FOUND: "list_workflows for its id or slug",
  TEMPLATE_NOT_FOUND: "list_templates for its id or slug",
  SECRET_NOT_FOUND: "list_secrets, then set_secret the missing one",
  INVALID_FIELD: "describe_table for the table's columns",
  UNDEFINED_COLUMN: "describe_table for the table's columns",
  UNDEFINED_TABLE: "list_resources for the table's schema and name; create_table if it doesn't exist",
  INVALID_RELATION: "describe_table: a dotted path follows a foreign key the table has",
  NOT_NULL_VIOLATION: "describe_table: that column is required - send a value",
  CHECK_VIOLATION: "describe_table for the rule (its CHECK and message), then send a value it accepts",
  UNIQUE_VIOLATION: "query_records for the row that already has that value - update it, or write_records with on_conflict",
  FOREIGN_KEY_VIOLATION: "write the referenced row first (write_records), or query_records for its key; a delete: remove what points at it first",
  PAYLOAD_CHECK_FAILED: "get_permissions for the role's payload checks on that table",
  INVALID_SCHEMA_OPERATION: "describe_table, then alter_table with operations the table's current shape allows (preview=true shows the SQL)",
  SQL_CONSOLE_DISABLED: "ask an administrator to turn on Settings > SQL Console > Allow API tokens; tables and rows don't need it (create_table, write_records)",
  TRANSACTIONS_DISABLED: "set_capability TRANSACTIONS for the role, or ask an administrator",
  DATAVIEW_VIEW_CONFIG_INVALID: "get_dataview for its current settings - the error names the key",
  DATAVIEW_WIDGET_INVALID: "describe the widget with get_page - the error names the prop",
  DATAVIEW_VARIABLES_INVALID: "get_page for the page's variables - the error names the one",
  DASHBOARD_QUERY_INVALID: "preview_query to try the SQL before save_widget",
  DASHBOARD_WIDGET_QUERY_FAILED: "preview_query to see PostgreSQL's error on that SQL",
  DASHBOARD_PUBLISH_BROKEN_WIDGETS: "get_dashboard, then fix each listed widget with save_widget (preview_query first)",
  DASHBOARD_DRAFT_CHANGED: "get_dashboard for the draft as it is now and its draftVersion, then apply_dashboard again",
  DASHBOARD_SPEC_INVALID: "get_dashboard for a valid spec to start from - the error names the path",
  WORKFLOW_INVALID_DESIGN: "get_workflow, then save_workflow - the error names the step",
  WORKFLOW_NOT_PUBLISHABLE: "get_workflow and fix what the error lists (a missing secret: set_secret), then publish_workflow",
  WORKFLOW_VALIDATION_FAILED: "get_workflow - the error names the step and its field",
  WORKFLOW_REVISION_CONFLICT: "get_workflow for its current revision, then save_workflow again",
  WORKFLOW_DISABLED: "set_workflow_enabled true",
  MISSING_TEMPLATE_VARIABLES: "test_template with every variable the template names",
  INVALID_COLUMN_PRESENTATION: "describe_table for the column's type - the error names the key",
  INVALID_ROW_PRESENTATION: "describe_table: a row presentation names the table's own columns",
  PASSWORD_TOO_SHORT: "a longer password (auth.password_min_length)",
  PASSWORD_TOO_LONG: "a password of at most 128 characters",
  PASSWORD_TOO_COMMON: "a less common password - this one is on the list of the most used",
  PERMISSION_EXCEEDS_CEILING: "get_permissions on the parent role - grant only the actions and fields it has",
  REAUTHENTICATION_REQUIRED: "use the plane=ADMIN token - a session must confirm its identity with POST /admin/api/auth/reauthenticate first",
  CROSS_SITE_REQUEST_REFUSED: "send the token as Authorization: Bearer - the session cookie is for the instance's own pages",
  RATE_LIMIT_EXCEEDED: "wait the Retry-After seconds, then batch (grant_permissions, write_records with a list)",
  INVALID_NAME: "a name of 1-32 characters: letters, digits, spaces and - _ . , : ; ( ) ' & +",
  INVALID_SLUG: "a slug of 1-32 lowercase letters, digits and hyphens",
};

/** The text an error code's fix adds - empty for a code with none. */
export function fixFor(code: string): string {
  const fix = ERROR_FIXES[code];
  return fix ? ` - fix: ${fix}` : "";
}
