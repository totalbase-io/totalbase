/**
 * A form field linked through a junction table (DataViews.md §8.5): the
 * other table's keys the record links to, picked several at once, and its
 * part of the record's save - an insert per link added, a delete (by the
 * junction row's key) per link removed, in the same transaction
 * (`record.attach`, the record engine's RecordLines). Nothing is written as
 * the viewer picks; PostgreSQL's UNIQUE keeps a link once.
 *
 * Vue reactivity only, the network behind `read` - so the App, the Design
 * form's Preview and the tests run the same code.
 */
import { reactive } from 'vue'
import type { VariableStatus } from '~/utils/variables-engine'
import type { RecordLines, RecordWriteOperation } from '~/utils/record-engine'

/** A junction table as `GET /app/api/dataviews/:slug/junctions/:resource` gives it. */
export interface JunctionCatalog {
  resourceId: string
  schema: string
  table: string
  primaryKey: string
  /** Its column pointing at the record's table. */
  column: string
  /** Its column pointing at the other table - what the field picks. */
  otherColumn: string
  target: { resourceId: string | null, schema: string, table: string, column: string }
  /** What this viewer may do to its rows - the Data API still decides every write. */
  actions: { read: boolean, create: boolean, delete: boolean }
}

/** A junction table of the record's table as the Design form offers it (`GET /admin/api/dataviews/junctions`). */
export type JunctionCandidate = Omit<JunctionCatalog, 'actions'>

/** One junction row: its key and the other table's key it links to. */
export interface JunctionRow {
  id: unknown
  other: unknown
}

export interface JunctionLinksHandle {
  /** The other table's keys linked, edits included - the field's value. */
  values: unknown[]
  status: VariableStatus
  /** Whether a link may be added or removed now - their grants; the record's mode is the field's to add. */
  canAdd: boolean
  canRemove: boolean
  set: (values: unknown) => void
}

export interface JunctionLinksOptions {
  junction: JunctionCatalog
  /** The junction rows of record `recordKey`. */
  read: (recordKey: unknown) => Promise<JunctionRow[]>
  /** Its operations' keys start with it - unique among the record's lines. */
  keyPrefix: string
  /** The values changed - the record's `dirty` follows (`record.linesChanged`). */
  changed?: () => void
}

const keyOf = (value: unknown) => JSON.stringify(value ?? null)

export function createJunctionLinks(options: JunctionLinksOptions) {
  const { junction } = options
  /** The links as read: the other table's key → its junction row's key. */
  let saved = new Map<string, JunctionRow>()
  let recordKey: unknown = null
  /** Only the latest read lands. */
  let reading = 0

  const handle: JunctionLinksHandle = reactive({
    values: [] as unknown[],
    status: 'idle' as VariableStatus,
    canAdd: junction.actions.create,
    canRemove: junction.actions.delete,
    set(next: unknown) {
      const list = Array.isArray(next) ? next : next === null || next === undefined ? [] : [next]
      // What the viewer may not do is never sent: a link they can't remove stays, one they can't add isn't added.
      const kept = handle.canRemove ? [] : [...saved.values()].map(row => row.other).filter(other => !list.some(v => keyOf(v) === keyOf(other)))
      const added = handle.canAdd ? list : list.filter(v => saved.has(keyOf(v)))
      const seen = new Set<string>()
      handle.values = [...added, ...kept].filter((v) => {
        const key = keyOf(v)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      options.changed?.()
    }
  }) as JunctionLinksHandle

  /** Reads the links of `key` (null: a new record, none yet). */
  async function load(key: unknown) {
    recordKey = key
    const current = ++reading
    if (key === null || key === undefined) {
      saved = new Map()
      handle.values = []
      handle.status = 'idle'
      options.changed?.()
      return
    }
    handle.status = 'pending'
    try {
      const rows = await options.read(key)
      if (current !== reading) return
      saved = new Map(rows.map(row => [keyOf(row.other), row]))
      handle.values = rows.map(row => row.other)
      handle.status = 'success'
    } catch {
      if (current !== reading) return
      handle.status = 'error'
    }
    options.changed?.()
  }

  const added = () => handle.values.filter(v => !saved.has(keyOf(v)))
  const removed = () => [...saved.values()].filter(row => !handle.values.some(v => keyOf(v) === keyOf(row.other)))

  const lines: RecordLines = {
    pending: () => added().length > 0 || removed().length > 0,
    operations(key): RecordWriteOperation[] {
      const table = { schema: junction.schema, table: junction.table }
      return [
        ...removed().map((row, index): RecordWriteOperation => ({ key: `${options.keyPrefix}Remove${index + 1}`, operation: 'delete', ...table, id: row.id })),
        ...added().map((other, index): RecordWriteOperation => ({ key: `${options.keyPrefix}Add${index + 1}`, operation: 'insert', ...table, data: { [junction.column]: key, [junction.otherColumn]: other } }))
      ]
    },
    saved: () => void load(recordKey),
    discard() {
      handle.values = [...saved.values()].map(row => row.other)
    }
  }

  return { handle, lines, load }
}
