#!/usr/bin/env node
// Calls the docs instance's MCP server (POST /mcp, JSON-RPC over streamable HTTP, stateless):
//   TOTALBASE_TOKEN=... node mcp.mjs <tool> '<json arguments>'   one tool (no tool: lists them)
//   TOTALBASE_TOKEN=... node mcp.mjs <steps.json>                 a list of [tool, arguments], in order,
//                                                                  stopping at the first error
// The demo is built through these tools, the way a customer's agent would (Docs_Demo_Field_Service.md §1).
import { appendFileSync, readFileSync } from 'node:fs'

const base = process.env.TOTALBASE_URL ?? 'http://localhost:3080'
const token = process.env.TOTALBASE_TOKEN
if (!token) throw new Error('TOTALBASE_TOKEN is required')

async function rpc(method, params, attempt = 0) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  // Settings > MCP's per-token limit: wait as told, then again.
  if (res.status === 429 && attempt < 10) {
    // Logged: a build on the default limits should never need one (Usability_85 §8).
    if (process.env.MCP_LOG) appendFileSync(process.env.MCP_LOG, JSON.stringify({ t: Date.now(), retry: 429 }) + '\n')
    await new Promise(r => setTimeout(r, 1000 * Number(res.headers.get('retry-after') ?? 15)))
    return rpc(method, params, attempt + 1)
  }
  let text = await res.text()
  if (!res.ok && !text.includes('jsonrpc')) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 400)}`)
  const data = text.split('\n').find(l => l.startsWith('data: '))
  if (data) text = data.slice(6)
  const msg = JSON.parse(text)
  if (msg.error) throw new Error(JSON.stringify(msg.error))
  return msg.result
}

/** What a call acts on, in a few words - for MCP_LOG. */
function target(args) {
  if (typeof args?.sql === 'string') return `${args.sql.split(';').filter(s => s.trim()).length} statements`
  const named = args?.name ?? args?.slug ?? args?.table ?? args?.email ?? args?.title ?? args?.key
  if (typeof named === 'string') return named
  if (Array.isArray(args?.grants)) return `${args.grants.length} grants`
  if (Array.isArray(args?.nodes)) return `${args.nodes.length} groups`
  return ''
}

export async function call(tool, args) {
  // MCP_LOG=<file>: one line per call, with its time - the documentation's build videos show them.
  if (process.env.MCP_LOG) appendFileSync(process.env.MCP_LOG, JSON.stringify({ t: Date.now(), tool, target: target(args) }) + '\n')
  const result = await rpc('tools/call', { name: tool, arguments: args })
  const out = (result.content ?? []).map(c => c.text ?? '').join('\n')
  if (result.isError) throw new Error(`${tool}: ${out}`)
  return out
}

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href
const [first, args = '{}'] = isMain ? process.argv.slice(2) : []
if (!isMain) {
  // imported: call() only
} else if (!first) {
  for (const t of (await rpc('tools/list', {})).tools) console.log(t.name)
} else if (first.endsWith('.json')) {
  const steps = JSON.parse(readFileSync(first, 'utf8'))
  for (const [i, [tool, stepArgs]] of steps.entries()) {
    try {
      await call(tool, stepArgs)
    } catch (error) {
      console.error(`step ${i + 1}/${steps.length} failed - ${error.message.slice(0, 800)}`)
      process.exit(2)
    }
  }
  console.log(`${steps.length} steps done`)
} else {
  try {
    console.log(await call(first, JSON.parse(args)))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
}
