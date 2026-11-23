/**
 * Columns that must never be readable or writable through the Data API (Security.md §10.2), no matter what a role's
 * field grant says - nor reached through a relation path from another table. Enforced by @totalbase/mutations'
 * guardrails on a resource's own columns and by @totalbase/query-engine on a relation's target; the Admin UI shows
 * them disabled in the field-grant checklist.
 */
export const PROTECTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "totalbase.users": ["password_hash"],
  "totalbase.sessions": ["token_hash"],
  "totalbase.emails_tokens": ["token_hash"],
  "totalbase.tokens": ["key_hash", "previous_key_hash"],
  "totalbase.secrets": ["ciphertext"],
  // A second factor's secret and recovery codes - not exposed today; never readable should a role ever be granted them.
  "totalbase.factors": ["secret"],
  "totalbase.factors_codes": ["code_hash"],
  "totalbase.challenges": ["token_hash"],
  // Writing storage_key would repoint a file at another file's stored content.
  "totalbase.files": ["storage_provider", "storage_key"],
  // The Data API never exposes generated SQL (AGENTS.md section 20) - an
  // administrator reads it through the Admin API's log detail.
  "totalbase.logs": ["sql_text", "sql_params"],
};

/** Whether `schema.table.field` is a protected column (PROTECTED_FIELDS) - never readable or writable through the Data API. */
export function isProtectedField(schema: string, table: string, field: string): boolean {
  return PROTECTED_FIELDS[`${schema}.${table}`]?.includes(field) ?? false;
}
