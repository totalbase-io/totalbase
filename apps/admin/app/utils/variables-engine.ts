/**
 * The variables engine (Specification_DataViews.md §8, §13.1):
 * turns a screen's variable definitions (`VariableDefinition[]`,
 * @totalbase/tb-catalog) into live, reactive handles - `vars.<name>` for
 * bindings and code - and keeps them in step:
 *
 * - Values start at their default and change through `set()` or a bound
 *   control; each change emits `update:value`.
 * - Resources load through the Data API (as the viewer - `transport.read`),
 *   `immediate` ones on `start()` in dependency order, and reload (debounced)
 *   when a variable their query uses changes, if they `watch`. The latest
 *   request wins: an older response arriving late is dropped.
 * - Calls run on `execute()` (`transport.call`), never on their own.
 *
 * `{{vars.<name>.<property>}}` in a Resource's query and a Call's input is
 * replaced by the variable's current value - as a value, never as code: the
 * query goes out as the Data API's filter grammar, whose values the server
 * binds as parameters. In a query's `where`, a condition whose value is unset
 * (null, empty text, empty list) is left out, so an empty filter control
 * means "no filter", and a value a viewer typed that starts with `$` is
 * refused - the filter grammar would read it as a `$USER`/`$PERIOD`
 * variable rather than text.
 *
 * Framework-light on purpose - Vue's reactivity only, the network behind
 * `transport` - so it runs the same in the Design form's Preview, the App and
 * a test.
 */
import {
  isValidValue,
  variableDependencies,
  type CallTarget,
  type CallVariableDefinition,
  type DateRangeValue,
  type ResourceVariableDefinition,
  type ValueDefault,
  type ValueType,
  type ValueVariableDefinition,
  type VariableDefinition
} from '@totalbase/tb-catalog'
import { reactive, watch, type WatchStopHandle } from 'vue'
import type { FormulaReturnType } from '~/utils/formula-engine'
import type { RecordHandle } from '~/utils/record-engine'

export type VariableStatus = 'idle' | 'pending' | 'success' | 'error'

export interface VariablesTransport {
  /** A Data API read of `resource` (its TotalBase id) with the Data API query object; `count` when asked for. */
  read: (resource: string, query: Record<string, unknown>) => Promise<{ data: unknown, count?: number }>
  /**
   * Runs a function (EXECUTE), a MANUAL workflow (INVOKE) or a table write
   * (CREATE/UPDATE/DELETE) as the viewer; resolves to its result. A failure
   * rejects with the API's errors on the error (`errors`), when it has them.
   */
  call: (target: CallTarget, input: Record<string, unknown>) => Promise<unknown>
}

export interface VariablesEngineOptions {
  transport: VariablesTransport
  /**
   * A variable's emit, for the host to run its Code function. For
   * `before:load` / `before:execute`, returning `false` cancels; for
   * `before:execute`, returning an object replaces the input.
   */
  emit?: (variable: string, event: string, payload: Record<string, unknown>) => unknown
  /**
   * A default that isn't a constant - a formula, a URL parameter or
   * `$USER.*` - resolved by the host; `vars` holds the variables defined
   * before this one.
   */
  resolveDefault?: (definition: ValueVariableDefinition, source: Exclude<ValueDefault, { source: 'constant' }>, vars: Record<string, VariableHandle>) => unknown
  /** How long a watching Resource waits after the last change before reloading. */
  debounceMs?: number
  /** The page's record (record-engine.ts), as `vars.record` - loaded by its host before `start()`. */
  record?: RecordHandle
}

export interface ValueHandle {
  readonly kind: 'VALUE'
  readonly type: ValueType
  value: unknown
  set: (value: unknown) => void
  reset: () => void
}

export interface ResourceHandle {
  readonly kind: 'RESOURCE'
  data: unknown
  status: VariableStatus
  error: string | null
  count: number | null
  /** The page it read, from 1. */
  page: number
  /** Its runtime search (`setSearch`) - null without one; the designed query's own applies then. */
  search: string | null
  /** Its query's limit - the page size; null without one. */
  readonly limit: number | null
  refresh: () => Promise<unknown>
  execute: () => Promise<unknown>
  clear: () => void
  setFilter: (filter: Record<string, unknown>) => Promise<unknown>
  clearFilter: () => Promise<unknown>
  setSearch: (text: string) => Promise<unknown>
  setOrder: (orderBy: string) => Promise<unknown>
  setPage: (page: number) => Promise<unknown>
  /** The row whose `column` is `value`, read on its own (the query's fields, none of its filters) - `data` stays as it is. */
  find: (column: string, value: unknown) => Promise<Record<string, unknown> | null>
  /** Creates a row of its table as the viewer (their CREATE permission) - a select's "Create" - and resolves to it. */
  create: (row: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** A failure as the API reports one (Specification_Data_API.md §2.4). */
export interface ApiErrors {
  errors: { code?: string, source?: 'TOTALBASE' | 'POSTGRESQL', message: string, field?: string, operation?: string }[]
}

/** The API's errors a failure carries - or the failure's own message as the one error. */
export function toApiErrors(error: unknown): ApiErrors {
  const errors = (error as { errors?: unknown } | null)?.errors
  if (Array.isArray(errors) && errors.length > 0 && errors.every(e => typeof (e as { message?: unknown })?.message === 'string')) {
    return {
      errors: errors.map((e) => {
        const { code, source, message, field, operation } = e as { code?: string, source?: 'TOTALBASE' | 'POSTGRESQL', message: string, field?: string, operation?: string }
        return { code, message, ...(source ? { source } : {}), ...(field ? { field } : {}), ...(operation ? { operation } : {}) }
      })
    }
  }
  return { errors: [{ message: error instanceof Error ? error.message : String(error) }] }
}

export interface CallHandle {
  readonly kind: 'CALL'
  data: unknown
  status: VariableStatus
  /** The last failure, as the API's `{ errors }` - null after a success. */
  error: ApiErrors | null
  execute: (input?: Record<string, unknown>) => Promise<unknown>
  setInput: (input: Record<string, unknown>) => void
  clear: () => void
}

export type VariableHandle = ValueHandle | ResourceHandle | CallHandle | RecordHandle

export interface VariablesEngine {
  /** Every variable by name - reactive. */
  vars: Record<string, VariableHandle>
  /** Loads the `immediate` Resources, in dependency order, and starts watching. */
  start: () => Promise<void>
  /** Stops watching and drops pending reloads. */
  dispose: () => void
}

/** A template standing alone in a value: `{{vars.cliente.value}}`, `{{vars.record.data.id}}` - a name and a path. */
const WHOLE_TEMPLATE = /^\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}$/
const ANY_TEMPLATE = /\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g
/** Left out of a `where` - see the file's doc comment. */
const UNSET = Symbol('unset')

export class VariableValueError extends Error {}

export function createVariablesEngine(definitions: readonly VariableDefinition[], options: VariablesEngineOptions): VariablesEngine {
  const debounceMs = options.debounceMs ?? 250
  const byName = new Map(definitions.map(d => [d.name, d]))
  const vars = reactive<Record<string, VariableHandle>>({})
  const stops: WatchStopHandle[] = []
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const emit = (name: string, event: string, payload: Record<string, unknown>) => options.emit?.(name, event, payload)

  if (options.record) vars.record = options.record
  for (const definition of definitions) {
    if (definition.kind === 'VALUE') vars[definition.name] = createValue(definition)
    else if (definition.kind === 'RESOURCE') vars[definition.name] = createResource(definition)
    else vars[definition.name] = createCall(definition)
  }

  // --- Value ---------------------------------------------------------------

  function initialValue(definition: ValueVariableDefinition): unknown {
    const def = definition.default
    if (!def) return null
    const raw = def.source === 'constant' ? def.value : options.resolveDefault?.(definition, def, vars)
    return coerce(definition.type, raw ?? null)
  }

  function createValue(definition: ValueVariableDefinition): ValueHandle {
    // reactive() itself, not a plain object inside `vars`: the methods below
    // write through `handle`, and those writes must reach watchers.
    const handle: ValueHandle = reactive({
      kind: 'VALUE',
      type: definition.type,
      value: initialValue(definition),
      set(value: unknown) {
        const next = coerce(definition.type, value)
        const previous = handle.value
        if (Object.is(previous, next)) return
        handle.value = next
        emit(definition.name, 'update:value', { value: next, previous })
      },
      reset() {
        handle.set(initialValue(definition))
      }
    }) as ValueHandle
    return handle
  }

  // --- Resource --------------------------------------------------------------

  function createResource(definition: ResourceVariableDefinition): ResourceHandle {
    let runtimeFilter: Record<string, unknown> | null = null
    let orderBy: string | null = null
    let latest = 0

    async function load(): Promise<unknown> {
      const request = ++latest
      let query: Record<string, unknown>
      try {
        query = buildQuery(definition, { runtimeFilter, search: handle.search, orderBy, page: handle.page })
      } catch (error) {
        handle.status = 'error'
        handle.error = error instanceof Error ? error.message : String(error)
        emit(definition.name, 'error', { error: handle.error })
        return handle.data
      }
      if ((await emit(definition.name, 'before:load', { query })) === false) return handle.data
      handle.status = 'pending'
      handle.error = null
      try {
        const result = await options.transport.read(definition.resource, query)
        if (request !== latest || disposed) return handle.data // a newer load started - this one is stale
        const rows = Array.isArray(result.data) ? result.data : []
        handle.data = definition.mode === 'record' ? rows[0] ?? null : rows
        handle.count = result.count ?? null
        handle.status = 'success'
        emit(definition.name, 'load', { data: handle.data, meta: { count: handle.count } })
        emit(definition.name, 'update:data', { data: handle.data })
      } catch (error) {
        if (request !== latest || disposed) return handle.data
        handle.status = 'error'
        handle.error = error instanceof Error ? error.message : String(error)
        emit(definition.name, 'error', { error: handle.error })
      }
      return handle.data
    }

    const handle: ResourceHandle = reactive({
      kind: 'RESOURCE',
      data: definition.mode === 'record' ? null : [],
      status: 'idle',
      error: null,
      count: null,
      page: 1,
      search: null,
      limit: typeof definition.query.limit === 'number' || typeof definition.query.limit === 'string' ? Number(definition.query.limit) || null : null,
      refresh: load,
      execute: load,
      clear() {
        latest++
        handle.data = definition.mode === 'record' ? null : []
        handle.count = null
        handle.status = 'idle'
        handle.error = null
      },
      setFilter(filter) {
        runtimeFilter = filter
        handle.page = 1
        return load()
      },
      clearFilter() {
        runtimeFilter = null
        handle.page = 1
        return load()
      },
      setSearch(text) {
        handle.search = text.trim() || null
        handle.page = 1
        return load()
      },
      setOrder(order) {
        orderBy = order || null
        return load()
      },
      setPage(n: number) {
        handle.page = Math.max(1, Math.floor(n))
        return load()
      },
      async find(column, value) {
        const { where: _where, ...rest } = definition.query
        const query: Record<string, unknown> = { ...(resolveTemplates(rest, 'plain') as Record<string, unknown>), where: { [column]: { _eq: value } }, limit: 1 }
        delete query.offset
        const result = await options.transport.read(definition.resource, query)
        const row = Array.isArray(result.data) ? result.data[0] : undefined
        return isRecord(row) ? row : null
      },
      async create(row) {
        const created = await options.transport.call({ type: 'TABLE', resource: definition.resource, action: 'CREATE' }, { data: row })
        return isRecord(created) ? created : {}
      }
    }) as ResourceHandle
    return handle
  }

  function buildQuery(
    definition: ResourceVariableDefinition,
    state: { runtimeFilter: Record<string, unknown> | null, search: string | null, orderBy: string | null, page: number }
  ): Record<string, unknown> {
    const { where, ...rest } = definition.query
    const query: Record<string, unknown> = { ...(resolveTemplates(rest, 'plain') as Record<string, unknown>) }
    const designed = where === undefined ? undefined : pruneUnset(resolveTemplates(where, 'filter'))
    const filters = [designed, state.runtimeFilter].filter((f): f is Record<string, unknown> => isRecord(f) && Object.keys(f).length > 0)
    if (filters.length === 1) query.where = filters[0]
    else if (filters.length === 2) query.where = { _and: filters }
    if (state.search) query.search = state.search
    if (state.orderBy) query.order_by = state.orderBy
    if (definition.count) query.count = true
    if (definition.mode === 'record') {
      query.limit = 1
    } else if (typeof query.limit === 'number' || typeof query.limit === 'string') {
      const limit = Number(query.limit)
      if (state.page > 1) query.offset = (state.page - 1) * limit
    }
    return query
  }

  // --- Call ------------------------------------------------------------------

  function createCall(definition: CallVariableDefinition): CallHandle {
    let input: Record<string, unknown> | undefined = definition.input

    const handle: CallHandle = reactive({
      kind: 'CALL',
      data: null,
      status: 'idle',
      error: null,
      async execute(override?: Record<string, unknown>) {
        let payload = (override ?? resolveTemplates(input ?? {}, 'plain')) as Record<string, unknown>
        const before = await emit(definition.name, 'before:execute', { input: payload })
        if (before === false) return handle.data
        if (isRecord(before)) payload = before
        handle.status = 'pending'
        handle.error = null
        try {
          handle.data = await options.transport.call(definition.target, payload)
          handle.status = 'success'
          emit(definition.name, 'success', { result: handle.data })
          return handle.data
        } catch (error) {
          handle.status = 'error'
          handle.error = toApiErrors(error)
          emit(definition.name, 'error', { error: handle.error })
          throw error
        } finally {
          emit(definition.name, 'complete', {})
        }
      },
      setInput(next) {
        input = next
      },
      clear() {
        handle.data = null
        handle.status = 'idle'
        handle.error = null
      }
    }) as CallHandle
    return handle
  }

  // --- Templates ---------------------------------------------------------------

  /**
   * A variable's property as a template reads it. A Value's `value`; a date
   * range's `from`/`to` as query bounds - a period becomes `$PERIOD.*`
   * (PostgreSQL computes it), two dates become `from` and the day after
   * `to` (exclusive); a Resource's or Call's `data`/`status`/`error`/`count`.
   */
  function readProperty(name: string, property: string | undefined, context: 'filter' | 'plain'): unknown {
    const handle = vars[name]
    if (!handle) throw new VariableValueError(`{{vars.${name}}} doesn't exist.`)
    if (handle.kind !== 'VALUE') return checked((handle as unknown as Record<string, unknown>)[property ?? 'data'], context)
    const value = handle.value
    if (property === undefined || property === 'value') return checked(value, context)
    if ((property === 'from' || property === 'to') && handle.type === 'date_range' && isRecord(value)) {
      const range = value as DateRangeValue
      if ('period' in range) return new TrustedBound(`$PERIOD.${range.period}.${property}`)
      return property === 'from' ? range.from : nextDay(range.to)
    }
    if ((property === 'from' || property === 'to') && handle.type === 'time_range' && isRecord(value)) return value[property]
    return isRecord(value) ? checked(value[property], context) : undefined
  }

  /** Viewer-typed text starting with `$` would be read as a filter variable, not text. */
  function checked(value: unknown, context: 'filter' | 'plain'): unknown {
    if (context === 'filter' && typeof value === 'string' && value.startsWith('$')) {
      throw new VariableValueError('A filter value can\'t start with "$".')
    }
    return value
  }

  /** `readProperty`, then on down the rest of the path: `{{vars.record.data.id}}`, `{{vars.cliente.data.nombre}}`. */
  function readPath(name: string, path: string, context: 'filter' | 'plain'): unknown {
    const [property, ...rest] = path ? path.slice(1).split('.') : []
    let value = readProperty(name, property, context)
    for (const key of rest) value = isRecord(value) ? value[key] : undefined
    return rest.length > 0 ? checked(value, context) : value
  }

  function resolveTemplates(node: unknown, context: 'filter' | 'plain'): unknown {
    if (typeof node === 'string') {
      const whole = WHOLE_TEMPLATE.exec(node)
      if (whole) return toQueryValue(readPath(whole[1]!, whole[2]!, context), context)
      if (!node.includes('{{')) return node
      let unset = false
      const text = node.replace(ANY_TEMPLATE, (_, name: string, path: string) => {
        const value = toQueryValue(readPath(name, path, context), context)
        if (value === UNSET) {
          unset = true
          return ''
        }
        return String(value)
      })
      return unset ? UNSET : text
    }
    if (Array.isArray(node)) return node.map(item => resolveTemplates(item, context))
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveTemplates(v, context)]))
    return node
  }

  /** In a filter, a list becomes the grammar's comma-separated form, and unset becomes UNSET. */
  function toQueryValue(value: unknown, context: 'filter' | 'plain'): unknown {
    if (value instanceof TrustedBound) return value.text
    if (context === 'plain') return value
    if (value === null || value === undefined || value === '') return UNSET
    if (Array.isArray(value)) {
      if (value.length === 0) return UNSET
      for (const item of value) checked(item, context)
      return value.join(',')
    }
    return value
  }

  // --- Lifecycle ---------------------------------------------------------------

  function scheduleReload(name: string) {
    if (disposed) return
    clearTimeout(timers.get(name))
    timers.set(name, setTimeout(() => {
      timers.delete(name)
      void (vars[name] as ResourceHandle).refresh()
    }, debounceMs))
  }

  async function start() {
    const loaded = new Map<string, Promise<unknown>>()
    const loadInOrder = (name: string, seen: Set<string>): Promise<unknown> => {
      const existing = loaded.get(name)
      if (existing) return existing
      const definition = byName.get(name)
      if (!definition || definition.kind !== 'RESOURCE' || !definition.immediate || seen.has(name)) return Promise.resolve()
      const next = new Set(seen).add(name)
      const promise = Promise.all(variableDependencies(definition).map(dep => loadInOrder(dep, next)))
        .then(() => (vars[name] as ResourceHandle).refresh())
      loaded.set(name, promise)
      return promise
    }
    await Promise.all(definitions.filter(d => d.kind === 'RESOURCE' && d.immediate).map(d => loadInOrder(d.name, new Set())))

    for (const definition of definitions) {
      if (definition.kind !== 'RESOURCE' || !definition.watch) continue
      if (!variableDependencies(definition).some(dep => dep in vars)) continue
      // What its query reads, resolved: a record's other columns changing, or a Resource's rows it doesn't use, reload nothing.
      stops.push(watch(() => {
        try {
          return JSON.stringify(resolveTemplates(definition.query, 'filter'), (_key, value: unknown) => (value === UNSET ? null : value))
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }, () => scheduleReload(definition.name)))
    }
  }

  function dispose() {
    disposed = true
    for (const stop of stops) stop()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { vars, start, dispose }
}

/** A bound the engine built itself (`$PERIOD.*`) - not viewer text, so exempt from the `$` check. */
class TrustedBound {
  constructor(readonly text: string) {}
}

/**
 * `value` as the variable's type: numeric text becomes a number, `"true"` a
 * boolean, a number a text... Anything that still isn't a valid value of the
 * type is refused - `set()` never stores a value of the wrong shape.
 */
export function coerce(type: ValueType, value: unknown): unknown {
  if (value === undefined || value === null) return null
  let next = value
  if (type === 'number' && typeof value === 'string' && value.trim() !== '') next = Number(value)
  else if (type === 'boolean' && (value === 'true' || value === 'false')) next = value === 'true'
  else if (type === 'text' && (typeof value === 'number' || typeof value === 'boolean')) next = String(value)
  else if (type === 'timestamp' && value instanceof Date) next = value.toISOString()
  // A day is the viewer's own, not UTC's: 21:00 on the 5th in Buenos Aires is the 5th, though UTC is on the 6th.
  else if (type === 'date' && value instanceof Date) next = localDate(value)
  if (!isValidValue(type, next)) throw new VariableValueError(`Not a valid ${type}: ${JSON.stringify(value)}`)
  return next
}

/** `date` as YYYY-MM-DD in the local time zone. */
function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * What a Value's formula default must produce, from the Value's type - the
 * destination decides (formula-engine.ts): TODAY() for a `date` is
 * 2026-10-05, the viewer's day, not a UTC instant. Undefined: as it comes.
 */
export function formulaTypeFor(type: ValueType): FormulaReturnType | undefined {
  if (type === 'date') return 'date'
  if (type === 'time') return 'time'
  if (type === 'timestamp') return 'datetime'
  if (type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  if (type === 'text') return 'string'
  return undefined
}

/** Removes every condition whose value is UNSET, and whatever that leaves empty. */
function pruneUnset(node: unknown): unknown {
  if (node === UNSET) return UNSET
  if (Array.isArray(node)) {
    const items = node.map(pruneUnset).filter(item => item !== UNSET && !(isRecord(item) && Object.keys(item).length === 0))
    return items
  }
  if (!isRecord(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    const pruned = pruneUnset(value)
    if (pruned === UNSET) continue
    if (isRecord(pruned) && Object.keys(pruned).length === 0) continue
    if (Array.isArray(pruned) && pruned.length === 0 && (key === '_and' || key === '_or' || key === '_not')) continue
    out[key] = pruned
  }
  return out
}

/** The day after an ISO date - a date range's inclusive `to` as an exclusive bound. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
