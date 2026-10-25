import { TotalBaseError } from "@totalbase/errors";
import { registerAdminIcons } from "./admin-icons.js";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyHttpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyRequest } from "fastify";

// apps/server/{src,dist} and apps/admin are workspace siblings, so this
// relative path resolves the same way whether this file is executing from
// src/ (tsx, dev) or dist/ (tsc build, prod) - see AGENTS.md's monorepo
// layout, unchanged by compilation.
const DEFAULT_ADMIN_UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../admin/.output/public");

/**
 * The server's own paths (Foundations.md §4.1): the API families, health
 * and MCP. Every other path belongs to the SPA.
 */
const API_PREFIXES = ["/api", "/admin/api", "/app/api", "/embed/api"];

export function isServerPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return API_PREFIXES.some(under) || under("/health") || path === "/mcp";
}

/**
 * The `'sha256-...'` source of every inline script in the built pages
 * (the color mode's and Nuxt's own config, its import map): the only
 * inline scripts the UI's Content-Security-Policy lets run. A JSON data
 * block (`type="application/json"`) never runs, so needs none.
 */
export function inlineScriptHashes(dir: string): string[] {
  const hashes = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".html"))) {
    const html = readFileSync(join(dir, file), "utf8");
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type\s*=\s*["']?application\/json/i.test(match[1] ?? "")) continue;
      hashes.add(`'sha256-${createHash("sha256").update(match[2] ?? "").digest("base64")}'`);
    }
  }
  return [...hashes];
}

/**
 * The UI pages' Content-Security-Policy (Foundations.md §4.7). Scripts:
 * the UI's own files and its known inline scripts - an injected
 * `<script>` or `onerror=` never runs; `'unsafe-eval'` because a
 * DataView's custom code is the administrator's JavaScript, run with
 * `new Function` (DataViews.md). Images, media, frames, fonts and
 * connections stay open: DataViews and dashboards show images and pages
 * from anywhere, maps load tiles, a DataView's code may call an API.
 */
export function uiContentSecurityPolicy(scriptSources: string, frameAncestors: string): string {
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "font-src * data:",
    "connect-src *",
    "frame-src * data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/** An unknown path under a reserved prefix: an API 404, never the SPA's page. */
export function routeNotFound(request: FastifyRequest): TotalBaseError {
  return new TotalBaseError("RESOURCE_NOT_FOUND", `No route for ${request.method} ${request.url.split("?")[0]}.`, { httpStatus: 404 });
}

/**
 * Serves the built apps/admin Nuxt SPA at the root, from the same process
 * and port as the APIs - "both live in one service" (Admin_UI.md §1.1).
 * Every path outside the server's own (isServerPath) is the SPA's: a real
 * built asset is served as is (@fastify/static, one route per file), and
 * any other GET falls back to index.html so Vue Router can take over.
 *
 * No-ops (with a log line) if apps/admin hasn't been built into this
 * checkout/image - lets apps/server keep running standalone.
 *
 * Local dev alternative: set devProxyTarget to a running `nuxt dev`
 * origin (e.g. http://localhost:3031) and this reverse-proxies every SPA
 * path there instead of serving a static build - the API and the
 * hot-reloading UI then both answer on this same port, so there's only
 * ever one URL to open.
 */
export async function registerAdminUi(
  app: FastifyInstance,
  enabled: boolean,
  dirOverride?: string,
  devProxyTarget?: string,
  embedFrameAncestors: (path: string) => Promise<string> = async () => "'self'",
): Promise<void> {
  if (!enabled) {
    app.log.info("admin UI disabled (TOTALBASE_ADMIN_UI_ENABLED=false) - only the server's own paths are served");
    return;
  }

  const dir = dirOverride ?? DEFAULT_ADMIN_UI_DIR;
  const built = !devProxyTarget && existsSync(join(dir, "index.html"));
  // The scripts the UI may run: the static build's own files and inline
  // scripts by hash; `nuxt dev`'s, which change on every edit and inject
  // their own, inline ones too.
  const scriptSources = built
    ? ["'self'", "'unsafe-eval'", ...inlineScriptHashes(dir)].join(" ")
    : "'self' 'unsafe-inline' 'unsafe-eval'";

  // The UI's Content-Security-Policy. Who may frame it (frame-ancestors):
  // an embed page the sites its embed allows, within
  // dashboards.embed_allowed_origins, and TotalBase itself (the drawer's
  // preview) - Dashboards.md §9.5; every other page only
  // TotalBase itself (its previews), never another site (clickjacking).
  // Added before the SPA handlers below, so it applies to them - the dev
  // proxy's answers and the static build's alike.
  app.addHook("onSend", async (request, reply, payload) => {
    if (isServerPath(request.url)) return payload;
    const path = request.url.split("?")[0] ?? "";
    const frameAncestors = path.startsWith("/embed/") ? await embedFrameAncestors(path) : "'self'";
    reply.header("Content-Security-Policy", uiContentSecurityPolicy(scriptSources, frameAncestors));
    return payload;
  });

  // An unknown path under an API prefix is an API 404, never a UI request:
  // the SPA handlers below would otherwise take it - in dev, proxying it
  // to `nuxt dev`, whose own Vite proxy forwards the API prefixes straight
  // back here, an endless loop that ties up sockets until every request
  // hangs; in prod, answering it with the SPA's index.html (200).
  // More specific than the SPA's /*, so find-my-way matches them first;
  // every real route is more specific still.
  for (const prefix of [...API_PREFIXES, "/health"]) {
    app.all(`${prefix}/*`, async (request) => {
      throw routeNotFound(request);
    });
  }
  // The UI's user-picked icons (admin-icons.ts) - ahead of the SPA's
  // proxy or static mount below, same as the guards above.
  registerAdminIcons(app);

  if (devProxyTarget) {
    app.log.info({ target: devProxyTarget }, "admin UI: proxying the SPA's paths to a local `nuxt dev` process");
    await app.register(fastifyHttpProxy, {
      upstream: devProxyTarget,
      websocket: true, // Vite's HMR client connects over ws for live reload.
    });
    return;
  }

  if (!built) {
    app.log.info({ dir }, "admin UI build not found - skipping static mount (run `pnpm --filter @totalbase/admin run generate` to enable)");
    return;
  }

  // wildcard: false - a route per built file, so the SPA's own fallback
  // below can be the one /* route.
  await app.register(fastifyStatic, { root: dir, wildcard: false });
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
}
