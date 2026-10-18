/**
 * Fields whose values never reach the audit log or the outbox - the
 * credential fields of a request body or a function call's arguments
 * (passwords, a secret's value, a provider's client secret, an
 * invitation/reset token). Matched on the whole key - ignoring case and
 * `_`/`-`, so `current_password` and `currentPassword` are the same field -
 * so a setting like `auth.password_min_length` is still recorded.
 */
const REDACTED_KEYS = new Set([
  "password", "currentpassword", "newpassword", "token", "value", "secret",
  "clientsecret", "clientsecretvalue", "privatekey",
]);

/** Whether a key names a credential field (see REDACTED_KEYS). */
export const isRedactedKey = (key: string): boolean => REDACTED_KEYS.has(key.replace(/[_-]/g, "").toLowerCase());

/** The same credential fields redacted by name, nothing else touched - a function call's arguments as the outbox keeps them. */
export function redactSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, isRedactedKey(key) ? "[redacted]" : redactSecretKeys(item)]));
  }
  return value;
}
