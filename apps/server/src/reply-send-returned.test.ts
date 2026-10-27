import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * An async handler or hook that sends must return the reply (Fastify's own rule). Without it, the handler's
 * promise resolves while an async onSend hook (hardening.ts's security headers) is still pending, reply.sent
 * is still false, and Fastify sends again: the second send hits headers already written and the caller gets a
 * 500 for a change that was made - DELETE /admin/api/workflows/:id did, under load. Checked on the source, as
 * the timing that shows it can't be reproduced on demand.
 */
describe("reply.send() is returned", () => {
  it("in every handler and hook of apps/server", () => {
    const offenders = sources(SRC).flatMap((file) => {
      let text = readFileSync(file, "utf8");
      // The error handler is synchronous: sending and returning nothing is fine there.
      if (file.endsWith("server.ts")) text = text.replace(/app\.setErrorHandler\([\s\S]*?\n {2}\}\);/, "");
      return text.split("\n").flatMap((line, index) =>
        /\breply(\.\w+\([^;]*?\))*\.send\(/.test(line) && !/\breturn\s+reply\b|=>\s*reply\b/.test(line)
          ? [`${relative(SRC, file)}:${index + 1}: ${line.trim()}`]
          : []);
    });
    expect(offenders).toEqual([]);
  });
});
