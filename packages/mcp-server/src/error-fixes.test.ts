import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOTALBASE_ERROR_CODES as ERROR_CODES } from "@totalbase/errors";
import { ERROR_FIXES } from "./error-fixes.js";
import { AdminApiError } from "./admin-client.js";

describe("what fixes an error", () => {
  const sources = readdirSync(new URL(".", import.meta.url)).filter((f) => f.startsWith("tools") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  const tools = new Set([...sources.matchAll(/^\s+"([a-z_]+)",\s*$/gm)].map((m) => m[1]!));

  it("is keyed by real error codes and names only tools this server has", () => {
    expect(Object.keys(ERROR_FIXES).filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
    const named = Object.values(ERROR_FIXES).flatMap((fix) => [...fix.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!));
    const settingsOrKeys = /^(auth|on_conflict|password_min_length)/;
    expect(named.filter((name) => !tools.has(name) && !settingsOrKeys.test(name))).toEqual([]);
  });

  it("is in the error's text an agent reads", () => {
    const error = new AdminApiError(403, [{ source: "TOTALBASE", code: "ACTION_DENIED", message: "No READ grant on public.orders for your roles." }]);
    expect(error.message).toMatch(/^ACTION_DENIED: No READ grant on public\.orders for your roles\. - fix: grant_permission/);
  });
});
