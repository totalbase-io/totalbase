import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";

/**
 * The admin UI's icon source for icons its client bundle doesn't carry -
 * the ones a user picks (a DataView's, a Dashboard's, a menu group's).
 * Nuxt Icon (apps/admin/nuxt.config.ts, `provider: 'server'`) asks
 * `/admin/_icons/<collection>.json?icons=a,b` in the Iconify API's own
 * format, so the admin never reaches out to api.iconify.design: works
 * offline, tells no third party what an instance uses.
 *
 * Only the collection the admin uses (lucide). Loaded on the first request,
 * not at boot - most sessions never need it.
 */

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ICONS_PER_REQUEST = 200;

interface IconifyIcon {
  body: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}
interface IconifyAlias {
  parent: string;
  [key: string]: unknown;
}
interface IconifyCollection {
  prefix: string;
  icons: Record<string, IconifyIcon>;
  aliases?: Record<string, IconifyAlias>;
  width?: number;
  height?: number;
  lastModified?: number;
}

const COLLECTION_PACKAGES: Record<string, string> = {
  lucide: "@iconify-json/lucide/icons.json",
};
const loaded = new Map<string, IconifyCollection>();
const require = createRequire(import.meta.url);

function loadCollection(prefix: string): IconifyCollection | undefined {
  const pkg = COLLECTION_PACKAGES[prefix];
  if (!pkg) return undefined;
  let collection = loaded.get(prefix);
  if (!collection) {
    collection = require(pkg) as IconifyCollection;
    loaded.set(prefix, collection);
  }
  return collection;
}

/**
 * The requested icons out of a collection, as the Iconify API answers: an
 * alias comes with its chain of parents (the client resolves it), a name
 * the collection lacks goes to `not_found`.
 */
export function pickIcons(collection: IconifyCollection, names: string[]) {
  const icons: Record<string, IconifyIcon> = {};
  const aliases: Record<string, IconifyAlias> = {};
  const notFound: string[] = [];
  for (const name of names) {
    let current = name;
    // An alias points at an icon or at another alias - follow the chain,
    // bounded in case a collection ever holds a cycle.
    for (let depth = 0; depth < 8; depth++) {
      const icon = collection.icons[current];
      if (icon) {
        icons[current] = icon;
        break;
      }
      const alias = collection.aliases?.[current];
      if (!alias) {
        if (current === name) notFound.push(name);
        break;
      }
      aliases[current] = alias;
      current = alias.parent;
    }
  }
  return {
    prefix: collection.prefix,
    lastModified: collection.lastModified,
    width: collection.width,
    height: collection.height,
    icons,
    ...(Object.keys(aliases).length ? { aliases } : {}),
    ...(notFound.length ? { not_found: notFound } : {}),
  };
}

export function registerAdminIcons(app: FastifyInstance): void {
  app.get<{ Params: { file: string }; Querystring: { icons?: string } }>("/admin/_icons/:file", async (request, reply) => {
    const match = /^([a-z0-9-]+)\.json$/.exec(request.params.file);
    const collection = match ? loadCollection(match[1]!) : undefined;
    if (!collection) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `No icon collection ${request.params.file}.`, { httpStatus: 404 });
    }
    const names = (request.query.icons ?? "").split(",").map(name => name.trim()).filter(Boolean);
    if (names.length === 0 || names.length > MAX_ICONS_PER_REQUEST || !names.every(name => ICON_NAME.test(name))) {
      throw new TotalBaseError("INVALID_QUERY", `icons must list 1-${MAX_ICONS_PER_REQUEST} icon names.`);
    }
    // An installed collection only changes with a TotalBase upgrade.
    reply.header("cache-control", "public, max-age=86400");
    return pickIcons(collection, names);
  });
}
