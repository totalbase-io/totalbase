/**
 * A CUSTOM DataView's Code (DataViews.md §11.1):
 * real JavaScript an administrator writes, compiled once with
 * `new Function` - the same deliberate trust decision as every DataView's
 * code (useDataViewController.ts) - and resolved by name: each widget and
 * variable emit names the function it calls.
 *
 * Unlike the other DataView types, handlers may be `async` and are awaited,
 * and a handler that throws is caught and reported: the page keeps working.
 */

export type CodeFunction = (...args: unknown[]) => unknown

export interface CompiledCode {
  functions: Record<string, CodeFunction>
  /** The compile error, when the code doesn't parse or its top level throws. */
  error: string | null
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Every function `code` declares at its top level, in order - `function name(`, `async function name(`, `const name = (…) =>`. */
export function declaredFunctions(code: string): string[] {
  const names = new Set<string>()
  const pattern = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g
  for (const match of code.matchAll(pattern)) names.add((match[1] ?? match[2])!)
  return [...names]
}

/** Compiles `code` and returns the functions named in `names` it declares. Never throws. */
export function compileCustomCode(code: string, names: readonly string[]): CompiledCode {
  const wanted = [...new Set(names)].filter(name => IDENTIFIER.test(name))
  if (!code.trim() || wanted.length === 0) return { functions: {}, error: null }
  try {
    const body = `${code}\nreturn { ${wanted.map(n => `${JSON.stringify(n)}: typeof ${n} === 'function' ? ${n} : undefined`).join(', ')} };`
    const exported = new Function(body)() as Record<string, CodeFunction | undefined>
    const functions: Record<string, CodeFunction> = {}
    for (const [name, fn] of Object.entries(exported)) if (fn) functions[name] = fn
    return { functions, error: null }
  } catch (error) {
    return { functions: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs handler `name` with `args`, awaiting it. A missing function resolves
 * to `undefined`; one that throws (or rejects) is reported to `onError` and
 * resolves to `undefined` - never breaks the caller.
 */
export async function runHandler(compiled: CompiledCode, name: string, args: unknown[], onError: (message: string) => void): Promise<unknown> {
  const fn = compiled.functions[name]
  if (!fn) return undefined
  try {
    return await fn(...args)
  } catch (error) {
    onError(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** A handler name for `event` of `owner` (a widget or a variable): `onEmitirSuccess`, `onButtonClick`. */
export function handlerName(owner: string, event: string, taken: readonly string[]): string {
  const words = `${owner} ${event}`.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const base = `on${words.map(w => w[0]!.toUpperCase() + w.slice(1)).join('')}`
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}${i}`
  return name
}

/** The scaffold "Create handler" appends to the Code. */
export function handlerScaffold(name: string, what: string, payload: string | undefined): string {
  const lines = [
    `${what}.`,
    payload ? `event: ${payload}` : 'event: nothing.',
    'dataview.vars.<name> - variables: .value / .set(v) (Value), .data / .refresh() (Resource), .execute(input) (Call).',
    'dataview.controls.<name>.open() / .close() / .focus(), dataview.notify(message, color), dataview.confirm(message), dataview.openFile(result), dataview.device.location().',
    'May be async - it is awaited.'
  ]
  return `\n${lines.map(line => `// ${line}`).join('\n')}\nasync function ${name}(dataview, event) {\n\n}\n`
}

/** A handler whose body a snippet wrote - "Create handler" with a snippet. */
export function handlerWithBody(name: string, what: string, payload: string | undefined, body: readonly string[]): string {
  const comment = [`// ${what}.`, ...(payload ? [`// event: ${payload}`] : [])]
  return `\n${comment.join('\n')}\nasync function ${name}(dataview, event) {\n${body.map(line => `  ${line}`).join('\n')}\n}\n`
}

/** What an embedded DataView linked to a page's record writes: its rows changing rereads the record. */
export function rowsChangedHandler(name: string): string {
  return `/** Rows of the embedded DataView changed (event.action: create, update, delete or import): reread the record - what a trigger recomputed shows up, edits in progress stay. */\nasync function ${name}(dataview, event) {\n  await dataview.vars.record.refresh()\n}\n`
}

/**
 * `code` without `block`, and the blank lines it leaves - when it's there as
 * written and its function isn't named anywhere else in the code. An edited
 * or called handler stays: it's the author's now.
 */
export function withoutUntouchedHandler(code: string, name: string, block: string): string {
  const at = code.indexOf(block)
  if (at === -1) return code
  const rest = code.slice(0, at) + code.slice(at + block.length)
  if (new RegExp(`\\b${name}\\b`).test(rest)) return code
  const joined = [code.slice(0, at).trimEnd(), code.slice(at + block.length).trimStart()].filter(Boolean).join('\n\n')
  return joined ? joined.replace(/\n*$/, '\n') : ''
}
