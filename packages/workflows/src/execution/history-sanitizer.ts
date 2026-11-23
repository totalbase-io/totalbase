/**
 * History payload handling (specs/Workflows.md §9):
 * SUMMARY never stores a step's input/result payload at all
 * (only status/timing/selected output/a sanitized error); DETAILED
 * stores them too, redacted and size-capped. Secrets are stripped
 * unconditionally, regardless of level - a workflow author choosing
 * DETAILED history never accidentally leaks a credential into
 * long-retention storage.
 */

import { FilterLiteral } from "@totalbase/query-engine";

/**
 * Keys whose value is a credential, at any depth - a webhook's inbound headers among them, whatever a caller named
 * its own (`X-Custom-Auth`, `X-Session`, `X-Signature`). `auth` but not `author`.
 */
const SENSITIVE_KEY_PATTERN = /password|passwd|secret|token|authori[sz]ation|auth(?!or)|cookie|session|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature|jwt|bearer/i;
/** A value that is a credential whatever its key: an HTTP authorization scheme and its credentials. */
const CREDENTIAL_VALUE_PATTERN = /^\s*(bearer|basic|digest|token)\s+\S{8,}/i;

function redact(value: unknown): unknown {
  // A Date's own fields aren't enumerable properties - Object.entries(date)
  // is always [], so without this it silently corrupts into {} below
  // (found live: a persisted DETAILED step's own `created_at` came back
  // "{}" instead of the real timestamp). Left as a Date instance, not
  // pre-stringified - JSON.stringify() (redactAndCap's own next step)
  // already calls its .toJSON() correctly on its own.
  if (value instanceof Date) return value;
  // A filter's carried value (templates.ts): the value it holds, as JSON shows it.
  if (value instanceof FilterLiteral) return redact(value.value);
  if (typeof value === "string" && CREDENTIAL_VALUE_PATTERN.test(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(v);
    }
    return result;
  }
  return value;
}

/** Redacts, then caps at maxBytes - past the cap the payload is replaced with a `{ truncated: true, originalSizeBytes }` marker rather than silently cutting the JSON (which would produce invalid/misleading partial data). */
function redactAndCap(value: unknown, maxBytes: number): unknown {
  const redacted = redact(value);
  const json = JSON.stringify(redacted) ?? "null";
  const size = Buffer.byteLength(json, "utf8");
  if (size <= maxBytes) return redacted;
  return { truncated: true, originalSizeBytes: size };
}

export interface HistoryPolicy {
  historyLevel: "SUMMARY" | "DETAILED";
  maxPayloadBytes: number;
}

/** A step/run's own `input`/`result` - null in SUMMARY (spec: "no payloads ever"), redacted+capped in DETAILED. */
export function sanitizePayload(value: unknown, policy: HistoryPolicy): unknown {
  if (policy.historyLevel === "SUMMARY") return null;
  if (value === undefined) return null;
  return redactAndCap(value, policy.maxPayloadBytes);
}

/** A step/run's own `error` - kept at every level (spec: SUMMARY still keeps "a sanitized error"), still redacted+capped since an error message/detail could itself echo sensitive input. */
export function sanitizeError(error: { code: string; message: string } | undefined, policy: HistoryPolicy): unknown {
  if (!error) return undefined;
  return redactAndCap(error, policy.maxPayloadBytes);
}
