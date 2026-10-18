import { TotalBaseError } from "@totalbase/errors";
import { registerAdminIcons } from "./admin-icons.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyHttpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// apps/server/{src,dist} and apps/admin are workspace siblings, so this
// relative path resolves the same way whether this file is executing from
// src/ (tsx, dev) or dist/ (tsc build, prod) - see AGENTS.md's monorepo
// layout, unchanged by compilation.
const DEFAULT_ADMIN_UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../admin/.output/public");

/**
 * Serves the built apps/admin Nuxt SPA under /admin/, from the same
 * process and port as the Admin/Data APIs - "both live in one service"
 * (Specification_Admin_UI.md §1.1).
 * @fastify/static's default wildcard route serves any real built asset
 * (including nested ones like /admin/_nuxt/*.js); a prefix-scoped
 * setNotFoundHandler on top of that is the documented @fastify/static
 * recipe for SPA client-side routing: any /admin/* request that isn't
 * a real built asset falls back to index.html so Vue Router can take
 * over.
 *
 * No-ops (with a log line) if apps/admin hasn't been built into this
 * checkout/image - lets apps/server keep running standalone.
 *
 * Local dev alternative: set devProxyTarget to a running `nuxt dev`
 * origin (e.g. http://localhost:3001) and this reverse-proxies /admin/*
 * there instead of serving a static build - the API and the
 * hot-reloading UI then both answer on this same port, so there's only
 * ever one URL to open. apps/admin/nuxt.config.ts's own vite proxy still
 * forwards /admin/api the other way (UI -> API) when Nuxt is opened
 * directly on its own port instead.
 */
export async function registerAdminUi(
  app: FastifyInstance,
  enabled: boolean,
  dirOverride?: string,
  devProxyTarget?: string,
  embedFrameAncestors: (path: string) => Promise<string> = async () => "'self'",
): Promise<void> {
  if (!enabled) {
    app.log.info("admin UI disabled (TOTALBASE_ADMIN_UI_ENABLED=false) - /admin/* will not be served");
    return;
  }

  // A browser asks the site's root for its icon whatever the page says: the UI's own (T58).
  app.get("/favicon.ico", async (_request, reply) => reply.redirect("/admin/favicon.ico", 301));

  // Who may frame the UI (Content-Security-Policy frame-ancestors): an
  // embed page the sites its embed allows, within
  // dashboards.embed_allowed_origins, and TotalBase itself (the drawer's
  // preview) - Specification_Dashboards.md §9.5; every other page only
  // TotalBase itself (its previews), never another site (clickjacking).
  // Added before the /admin/* handlers below, so it applies to them -
  // the dev proxy's answers and the static build's alike.
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/admin/") || path.startsWith("/admin/api/")) return payload;
    if (path.startsWith("/admin/embed/")) {
      reply.header("Content-Security-Policy", `frame-ancestors ${await embedFrameAncestors(path)}`);
    } else {
      reply.header("Content-Security-Policy", "frame-ancestors 'self'");
    }
    return payload;
  });

  // An unknown /admin/api/* path is an API 404, never a UI request: the
  // /admin/* handlers below would otherwise take it - in dev, proxying it
  // to `nuxt dev`, whose own Vite proxy forwards /admin/api straight back
  // here, an endless loop that ties up sockets until every /admin/*
  // request hangs; in prod, answering it with the SPA's index.html (200).
  // More specific than /admin/*, so find-my-way matches it first; every
  // real Admin API route is more specific still.
  app.all("/admin/api/*", async (request) => {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `No Admin API route for ${request.method} ${request.url.split("?")[0]}.`, {
      httpStatus: 404,
    });
  });
  // The UI's user-picked icons (admin-icons.ts) - ahead of the /admin/*
  // proxy or static mount below, same as the guard above.
  registerAdminIcons(app);

  if (devProxyTarget) {
    app.log.info({ target: devProxyTarget }, "admin UI: proxying /admin/* to a local `nuxt dev` process");
    await app.register(fastifyHttpProxy, {
      upstream: devProxyTarget,
      prefix: "/admin",
      rewritePrefix: "/admin",
      websocket: true, // Vite's HMR client connects over ws for live reload.
    });
    // @nuxt/fonts registers its dev-only font-proxy route at /_fonts/* on
    // the app root, ignoring `baseURL` - so it falls outside the /admin
    // prefix above and needs its own passthrough. Prod doesn't need this:
    // `nuxt generate` downloads and self-hosts the fonts into the static
    // build, no runtime proxy involved.
    await app.register(fastifyHttpProxy, {
      upstream: devProxyTarget,
      prefix: "/_fonts",
      rewritePrefix: "/_fonts",
    });
    return;
  }

  const dir = dirOverride ?? DEFAULT_ADMIN_UI_DIR;
  if (!existsSync(join(dir, "index.html"))) {
    app.log.info({ dir }, "admin UI build not found - skipping static mount (run `pnpm --filter @totalbase/admin run generate` to enable)");
    return;
  }

  await app.register(async (adminApp) => {
    await adminApp.register(fastifyStatic, {
      root: dir,
    });
    adminApp.setNotFoundHandler((_request, reply) => {
      reply.sendFile("index.html");
    });
  }, { prefix: "/admin" });
}
