/**
 * totalbase.users' own columns - TotalBase's, written by its migrations. Any other column is the
 * project's (AGENTS.md §11: the table is extensible): the admin's Users shows and edits those as Additional
 * data, and the Admin API's user list filters by them. A migration adding a column here adds it to this list
 * (a test compares the two).
 */
export const TOTALBASE_USER_COLUMNS: readonly string[] = [
  "id", "email", "password_hash", "name", "avatar_url", "active", "email_verified_at", "last_login_at", "created_at", "updated_at",
  "owner", "can_login", "failed_login_count", "locked_until", "preferences",
];

/** A column a project added to users. */
export function isProjectUserColumn(column: string): boolean {
  return !TOTALBASE_USER_COLUMNS.includes(column);
}
