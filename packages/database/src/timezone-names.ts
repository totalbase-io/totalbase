import type { Queryable } from "./database.js";

/**
 * The zones PostgreSQL knows (`pg_timezone_names`), and PostgreSQL's name for
 * the ones browsers spell differently (Security.md §4.2).
 *
 * A browser reports ICU's canonical id, which for some twenty zones is
 * IANA's *legacy* alias: `America/Buenos_Aires` for
 * `America/Argentina/Buenos_Aires`, `Asia/Calcutta` for `Asia/Kolkata`,
 * `Europe/Kiev` for `Europe/Kyiv`. A PostgreSQL built on a tzdata without
 * the `backward` links (Debian 13's, the official images') doesn't know those
 * aliases, so taken as is they would be dropped. The map is learned, once per
 * database, from PostgreSQL itself: each of its names canonicalized by Node's
 * ICU - where the two differ and PostgreSQL lacks ICU's spelling, that
 * spelling stands for PostgreSQL's name. Nothing to keep by hand; PostgreSQL
 * stays the authority of which zones exist.
 */
export interface TimezoneNames {
  /** Whether PostgreSQL knows `name` as written. */
  has(name: string): boolean;
  /**
   * PostgreSQL's name for `name`: itself when PostgreSQL knows it, the zone its
   * ICU spelling stands for when PostgreSQL lacks that alias, else undefined.
   */
  canonical(name: unknown): string | undefined;
}

const cache = new WeakMap<object, Promise<TimezoneNames>>();

/** Read once per database (a failed read is retried on the next call). */
export function timezoneNames(client: Queryable): Promise<TimezoneNames> {
  let pending = cache.get(client);
  if (!pending) {
    pending = load(client).catch((error: unknown) => {
      cache.delete(client);
      throw error;
    });
    cache.set(client, pending);
  }
  return pending;
}

async function load(client: Queryable): Promise<TimezoneNames> {
  const { rows } = await client.query<{ name: string }>("SELECT name FROM pg_timezone_names");
  const known = new Set(rows.map((r) => r.name));
  const aliases = new Map<string, string>();
  for (const name of known) {
    const icu = icuName(name);
    if (icu && icu !== name && !known.has(icu) && !aliases.has(icu)) aliases.set(icu, name);
  }
  return {
    has: (name) => known.has(name),
    canonical: (name) => (typeof name === "string" && name ? (known.has(name) ? name : aliases.get(name)) : undefined),
  };
}

/** How ICU (and so a browser) spells `name` - undefined for a name ICU doesn't know. */
function icuName(name: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
