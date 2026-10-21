/**
 * History payload handling (specs/Workflows.md §9):
 * SUMMARY never stores a step's input/result payload at all
 * (only status/timing/selected output/a sanitized error); DETAILED
 * stores them too, redacted and size-capped. Secrets are stripped
 * unconditionally, regardless of level - a workflow author choosing
 * DETAILED history never accidentally leaks a credential into
 * long-retention storage.
 */
const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|cookie|api[_-]?key/i;

function redact(value: unknown): unknown {
  // A Date's own fields aren't enumerable properties - Object.entries(date)
  // is always [], so without this it silently corrupts into {} below
  // (found live: a persisted DETAILED step's own `created_at` came back
  // "{}" instead of the real timestamp). Left as a Date instance, not
  // pre-stringified - JSON.stringify() (redactAndCap's own next step)
  // already calls its .toJSON() correctly on its own.
  if (value instanceof Date) return value;
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
