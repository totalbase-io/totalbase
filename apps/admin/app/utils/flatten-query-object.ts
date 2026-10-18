/**
 * Flattens a nested filter object (the `where`/`having` grammar's JSON
 * shape, e.g. `{status: {_eq: 'active'}, _and: [...]}`) into the flat
 * `prefix[key][key]=value` query keys the server's `qs` querystring
 * parser (apps/server/src/server.ts) re-nests back into the same object
 * (AGENTS.md section 7's "one grammar, three uses" - this is the fourth:
 * a DataView grid's Filter panel, sending the same grammar over GET
 * query params instead of a request body).
 *
 * $fetch/ufo doesn't itself serialize nested objects into bracket
 * notation, so this has to happen before handing params to it. Every
 * value ends up a string (URL query values always are) - the same
 * requirement `parseValue` in packages/query-engine already imposes on
 * every `where[...]` value it accepts.
 */
export function flattenQueryObject(value: unknown, prefix: string): Record<string, string> {
  const out: Record<string, string> = {}

  function walk(node: unknown, path: string) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (typeof node === 'object') {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        walk(val, `${path}[${key}]`)
      }
      return
    }
    out[path] = String(node)
  }

  walk(value, prefix)
  return out
}
