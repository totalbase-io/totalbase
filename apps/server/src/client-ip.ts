import { isIP } from "node:net";
import type { Database } from "@totalbase/database";
import type { FastifyRequest } from "fastify";

/**
 * The address a request came from, as PostgreSQL compares it with a list of allowed addresses (a token's
 * `allowed_ips`, a webhook's `allowed_ips` - Security.md §3.5, Workflows.md §6.5): Fastify's `request.ip`,
 * which is the real client behind a proxy only with `security.trusted_proxies` (Administration.md §7.7). An
 * IPv4 client on a dual-stack socket arrives as `::ffff:a.b.c.d` and is given back as `a.b.c.d`, so an IPv4
 * range matches it. Undefined for anything that is not an address: a restricted credential is then refused.
 */
export function clientIp(request: Pick<FastifyRequest, "ip">): string | undefined {
  // A connection without a socket address (an injected WebSocket) has no ip at all.
  const address = String(request.ip ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(address) === 0 ? undefined : address;
}

/** Whether `address` is in one of `ranges` (addresses and CIDR ranges) - PostgreSQL's `<<=`, as for a token. */
export async function ipInRanges(database: Database, address: string | undefined, ranges: string[]): Promise<boolean> {
  if (address === undefined) return false;
  const { rows } = await database.query<{ allowed: boolean | null }>(`SELECT $1::inet <<= ANY($2::inet[]) AS allowed`, [address, ranges]);
  return rows[0]?.allowed === true;
}
