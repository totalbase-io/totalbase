import { describe, expect, it } from "vitest";
import { sanitizeError, sanitizePayload } from "./history-sanitizer.js";

describe("history-sanitizer", () => {
  it("SUMMARY never persists a payload", () => {
    expect(sanitizePayload({ name: "Acme" }, { historyLevel: "SUMMARY", maxPayloadBytes: 65_536 })).toBeNull();
  });

  it("DETAILED persists a payload, redacting sensitive keys", () => {
    const result = sanitizePayload({ name: "Acme", password: "hunter2" }, { historyLevel: "DETAILED", maxPayloadBytes: 65_536 });
    expect(result).toEqual({ name: "Acme", password: "[REDACTED]" });
  });

  it("preserves a Date value instead of collapsing it to {}", () => {
    const createdAt = new Date("2026-09-22T16:34:28.373Z");
    const result = sanitizePayload({ id: "1", created_at: createdAt }, { historyLevel: "DETAILED", maxPayloadBytes: 65_536 }) as { created_at: Date };
    expect(result.created_at).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(result)).created_at).toBe("2026-09-22T16:34:28.373Z");
  });

  it("preserves a Date nested inside an array", () => {
    const createdAt = new Date("2026-09-22T16:34:28.373Z");
    const result = sanitizePayload({ data: [{ id: "1", created_at: createdAt }] }, { historyLevel: "DETAILED", maxPayloadBytes: 65_536 }) as { data: { created_at: Date }[] };
    expect(result.data[0]!.created_at).toBeInstanceOf(Date);
  });

  it("sanitizeError omits an undefined error and redacts+keeps the rest", () => {
    expect(sanitizeError(undefined, { historyLevel: "SUMMARY", maxPayloadBytes: 65_536 })).toBeUndefined();
    expect(sanitizeError({ code: "FOO", message: "bad" }, { historyLevel: "SUMMARY", maxPayloadBytes: 65_536 })).toEqual({ code: "FOO", message: "bad" });
  });
});
