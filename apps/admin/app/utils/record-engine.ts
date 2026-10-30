/**
 * A page's record (DataViews.md §8.5): one row
 * of the DataView's source table, loaded, edited and saved through the Data
 * API as the viewer - `dataview.vars.record` in code, `{{vars.record.data.<column>}}`
 * in formulas, and what a form field bound to a column edits.
 *
 * What the table says about a column is read live, never copied into the
 * page: required (NOT NULL with no default), generated, a foreign key's
 * target, and whether this viewer may read it or write it now. PostgreSQL
 * still decides every save - a failure leaves the record as it was and
 * reports the API's errors.
 *
 * Vue reactivity only, the network behind a transport - so the App, the
 * Design form's Preview and the tests run the same code.
 */
import { format as formatDateFns } from 'date-fns'
import { reactive, ref } from 'vue'
import { checkConstraintDateBounds, checkConstraintValues, columnValueKind, type ColumnBound, type ColumnPattern, type DateBound } from '@totalbase/tb-catalog'
import { toApiErrors, type ApiErrors, type VariableStatus } from '~/utils/variables-engine'
import { FORM_MESSAGES, rangeErrors } from '~/utils/widget-form'

/** A column as the record's catalog gives it (@totalbase/pg-catalog's ColumnDefinition). */
export interface RecordCatalogColumn {
  name: string
  dataType: string
  nullable: boolean
  isIdentity: boolean
  isGenerated: boolean
  defaultExpression: string | null
}

/** The record table as the viewer may use it - `GET /app/api/dataviews/:slug/record`. */
export interface RecordCatalog {
  catalog: {
    columns: RecordCatalogColumn[]
    primaryKey: string[]
    relations: { sourceColumn: string, targetSchema: string, targetTable: string, targetColumn: string }[]
    /** Its CHECKs, as `pg_get_constraintdef` renders them - a column's plain list of values offered as options. */
    checkConstraints?: { expression: string }[]
  }
  /** Password columns (Security.md §2.3): in `columns` so a field sets them, never read - a read leaves them out. */
  writeOnly?: string[]
  writable: { create: string[], update: string[] }
  /** The regular expressions the writable columns' CHECKs hold - what a form checks before saving. */
  patterns?: Record<string, ColumnPattern[]>
  /** The ranges the writable columns' CHECKs hold (`price >= 0`, `length(code) <= 10`). */
  bounds?: Record<string, ColumnBound[]>
  /** The days the writable date columns' CHECKs allow - the App's route; the Preview reads them from checkConstraints. */
  dateBounds?: Record<string, DateBound[]>
  /** The readable columns' CHECK lists' values - the App's route; the Preview reads them from checkConstraints. */
  values?: Record<string, string[]>
}

export interface RecordColumn {
  name: string
  dataType: string
  /** PostgreSQL requires a value: NOT NULL, no default, not identity or generated. */
  required: boolean
  /** It may be null (no NOT NULL) - what Leave empty sets. */
  nullable: boolean
  /** Identity or generated: PostgreSQL writes it. */
  generated: boolean
  creatable: boolean
  updatable: boolean
  foreignKey: { schema: string, table: string, column: string } | null
  /** Its CHECKs' regular expressions, as a form anticipates them - PostgreSQL still decides the save. */
  patterns: ColumnPattern[]
  /** Its CHECKs' ranges, as a form anticipates them - PostgreSQL still decides the save. */
  bounds: ColumnBound[]
  /** A date's CHECK bounds (`<= CURRENT_DATE`, `>= '2020-01-01'`) - its calendar offers no day past them. */
  dateBounds: DateBound[]
  /** The values its CHECK lists (`IN ('A', 'B')`, `IN (0, 10.5, 21)`) - in the shape the Data API reads the column (checkValueShape); a select bound to it offers them; null: not a list. */
  values: (string | number)[] | null
  /** Its DEFAULT when it is a constant ('CELULAR', true, 30) - a new record starts with it, so it shows what PostgreSQL would store. */
  literalDefault: unknown
}

/** A DEFAULT that is a constant - a quoted literal (with its cast), a boolean, a number; undefined for anything else (now(), a sequence, a function). */
/**
 * A CHECK list's value (as PostgreSQL wrote it, text) in the shape the Data API reads its column - so a select's
 * option is the record's value: an integer a number, a numeric(p,s) with its scale ("21.00"), a bigint or a bare
 * numeric the text PostgreSQL writes, text as is (T61).
 */
export function checkValueShape(raw: string, dataType: string): string | number {
  if (/^(smallint|integer|real|double precision)$/.test(dataType)) return Number(raw)
  const scale = /^numeric\(\d+,\s*(\d+)\)/.exec(dataType)?.[1]
  return scale !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw).toFixed(Number(scale)) : raw
}

export function literalDefault(expression: string | null, dataType?: string): unknown {
  if (expression === null) return undefined
  // A date column defaulting to today (CURRENT_DATE, now()) starts on the viewer's today - what PostgreSQL would
  // store, shown (T61). A timestamp's now() stays PostgreSQL's: the instant of the save, not of the form.
  if (dataType === 'date' && /^(CURRENT_DATE|now\(\)|CURRENT_TIMESTAMP|\(?now\(\)\)?::date)$/i.test(expression.trim())) return formatDateFns(new Date(), 'yyyy-MM-dd')
  const text = /^'((?:[^']|'')*)'(?:::[a-z ]+(?:\(\d+(?:,\d+)?\))?(?:\[\])?)?$/i.exec(expression.trim())
  if (text) return text[1]!.replace(/''/g, '\'')
  if (/^(true|false)$/i.test(expression.trim())) return expression.trim().toLowerCase() === 'true'
  const number = /^\(?(-?\d+(?:\.\d+)?)\)?(?:::[a-z ]+)?$/i.exec(expression.trim())
  if (number) return Number(number[1])
  return undefined
}

export type RecordMode = 'create' | 'edit' | 'view'

export interface RecordTransport {
  catalog: () => Promise<RecordCatalog>
  read: (pk: unknown) => Promise<Record<string, unknown> | null>
  create: (data: Record<string, unknown>) => Promise<Record<string, unknown>>
  update: (pk: unknown, data: Record<string, unknown>) => Promise<Record<string, unknown>>
  remove: (pk: unknown) => Promise<void>
  /** The record's table - what its header write names when it saves together with its lines. */
  table?: { schema: string, name: string }
  /** The record and its lines in one transaction (DataViews.md §6.6) - each operation's resulting row, by key. */
  saveTogether?: (operations: RecordWriteOperation[]) => Promise<Record<string, Record<string, unknown>>>
}

/** One write of a save together - the transactions format (Data_API.md §8). */
export interface RecordWriteOperation {
  key: string
  operation: 'insert' | 'update' | 'delete'
  schema: string
  table: string
  id?: unknown
  data?: Record<string, unknown>
}

/**
 * Lines edited with the record and saved with it (a master-detail's, DataViews.md §6.6): their
 * pending writes join the record's save, in one transaction.
 */
export interface RecordLines {
  /** Whether it has changes not saved yet. */
  pending: () => boolean
  /** Its writes; `recordKey` is the record's key in them - its value, or `$header.<key>` for a record saved in the same go. */
  operations: (recordKey: unknown) => RecordWriteOperation[]
  /** Saved: forget the changes and read the lines again. */
  saved: () => void
  /** Cancelled: back to the lines as read. */
  discard: () => void
}

export interface RecordHandle {
  readonly kind: 'RECORD'
  /** The row's values - edits included. */
  data: Record<string, unknown>
  mode: RecordMode
  /** Whether it has unsaved changes. */
  dirty: boolean
  /** Opened read-only (`open(pk, true)`): saving or cancelling an edit returns it to reading. */
  restsInView: boolean
  status: VariableStatus
  /** The last failure, as the API's `{ errors }` - null after a success. */
  error: ApiErrors | null
  /** The table's columns, by name - empty until the catalog loads. */
  columns: Record<string, RecordColumn>
  /** The primary key's value - null for a new record. */
  pk: unknown
  /** The primary key's column - null until the catalog loads. */
  primaryKey: string | null
  set: (column: string, value: unknown) => void
  /** Whether this viewer may write `column` now (its mode, their grants, PostgreSQL's own columns). */
  canEdit: (column: string) => boolean
  save: (values?: Record<string, unknown>) => Promise<boolean>
  cancel: () => void
  new: (values?: Record<string, unknown>) => void
  reload: () => Promise<void>
  /**
   * Opens another row by its key - read-only with `view` until edit(). With `row`, the row as a list already
   * holds it (a grid's): shown and editable at once, then read again keeping what was typed meanwhile - no
   * empty, locked form while it loads. Without one, its fields wait for the read.
   */
  open: (pk: unknown, view?: boolean, row?: Record<string, unknown>) => Promise<void>
  /** Reads it again, keeping every edit in progress - what a trigger recomputed (totals from a Detail's rows) shows up, what the viewer typed stays. */
  refresh: () => Promise<void>
  delete: () => Promise<boolean>
  edit: () => void
  clone: () => void
  close: () => void
  /** Lines that save with it - returns their detach. */
  attach: (lines: RecordLines) => () => void
  /** Its lines changed - `dirty` follows them too. */
  linesChanged: () => void
}

export interface RecordOptions {
  transport: RecordTransport
  /** The record's emits (`load`, `before:save`, `save`), for the host to run its Code function; `before:save` returning false cancels. */
  emit?: (event: string, payload: Record<string, unknown>) => unknown
  notify?: (message: string, color: 'error' | 'success') => void
  confirm?: (message: string) => boolean | Promise<boolean>
  /** Closes the record's page or panel - the host's. */
  close?: () => void
  /** The UI's language for the record's own notices (Admin_UI.md §14) - English when not given. */
  t?: (key: string) => string
  /** Whether a column has a field on screen - its error shows there instead of as a notice. */
  showsField?: (column: string) => boolean
  /** An error as the viewer reads it - in their language where it has a fixed meaning (apiErrorText); its message when not given. */
  describe?: (error: ApiErrors['errors'][number]) => string
}

function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** The table's columns for the record, from its catalog. */
export function recordColumns(record: RecordCatalog): Record<string, RecordColumn> {
  const { catalog, writable } = record
  const create = new Set(writable.create)
  const update = new Set(writable.update)
  return Object.fromEntries(catalog.columns.map((column) => {
    const generated = column.isIdentity || column.isGenerated
    const relation = catalog.relations.find(r => r.sourceColumn === column.name)
    return [column.name, {
      name: column.name,
      dataType: column.dataType,
      required: !column.nullable && column.defaultExpression === null && !generated,
      nullable: column.nullable,
      generated,
      // A key PostgreSQL assigns (serial, a uuid default) is never typed: read only on a new record too.
      creatable: create.has(column.name) && !generated && !(catalog.primaryKey.includes(column.name) && column.defaultExpression !== null),
      updatable: update.has(column.name) && !generated && !catalog.primaryKey.includes(column.name),
      foreignKey: relation ? { schema: relation.targetSchema, table: relation.targetTable, column: relation.targetColumn } : null,
      patterns: record.patterns?.[column.name] ?? [],
      bounds: record.bounds?.[column.name] ?? [],
      dateBounds: record.dateBounds?.[column.name] ?? (/^(date|timestamp)/.test(column.dataType) ? checkConstraintDateBounds(column.name, (catalog.checkConstraints ?? []).map(c => ({ expression: c.expression, message: null }))) : []),
      values: (record.values?.[column.name] ?? checkConstraintValues(column.name, (catalog.checkConstraints ?? []).map(c => c.expression)))?.map(v => checkValueShape(v, column.dataType)) ?? null,
      literalDefault: generated ? undefined : literalDefault(column.defaultExpression, column.dataType)
    }]
  }))
}

export function createRecord(options: RecordOptions) {
  const { transport } = options
  const text = (key: string, english: string) => options.t ? options.t(key) : english
  let primaryKey: string | null = null
  /** A row being read (open, reload): its fields wait for it - typing before it arrives would be overwritten. */
  const reading = ref(false)
  /** The values as loaded or last saved - what `dirty` and an update compare against. */
  let saved: Record<string, unknown> = {}
  /** Lines that save with it (attach). */
  const lines = new Set<RecordLines>()
  const linesPending = () => [...lines].some(l => l.pending())
  const dataDirty = () => Object.keys({ ...handle.data, ...saved }).some(key => !same(handle.data[key], saved[key]))

  const emit = (event: string, payload: Record<string, unknown>) => options.emit?.(event, payload)
  function fail(error: unknown) {
    handle.status = 'error'
    handle.error = toApiErrors(error)
    // An error about a column with its field on screen shows on that field (WidgetRenderer.vue); the rest as notices.
    for (const e of handle.error.errors) {
      if (!e.field || !options.showsField?.(e.field)) options.notify?.(options.describe ? options.describe(e) : e.message, 'error')
    }
  }
  /** A row read again: each value the viewer hasn't changed takes the new one; what they typed stays. */
  function mergeKeepingEdits(row: Record<string, unknown>) {
    for (const [column, value] of Object.entries(row)) {
      if (same(handle.data[column], saved[column])) handle.data[column] = copy(value)
      saved[column] = copy(value)
    }
    handle.dirty = dataDirty() || linesPending()
  }
  function load(row: Record<string, unknown>, mode: RecordMode) {
    handle.data = copy(row)
    saved = copy(row)
    handle.mode = mode
    handle.pk = mode === 'create' || !primaryKey ? null : row[primaryKey] ?? null
    handle.dirty = false
    handle.error = null
    emit('load', { data: copy(row) })
  }
  /** What a save sends: on create every value set of a column the viewer may create; on update only what changed. */
  /**
   * An emptied input is no value (null), sent as such: a number input empties to undefined (or NaN) -
   * dropped from the request, the change was lost - and "" is a value only text holds, PostgreSQL
   * refuses it anywhere else (22P02). A NOT NULL column then says it's required, as any empty field does.
   */
  function emptyAsNull(column: string, value: unknown): unknown {
    if (value === undefined || (typeof value === 'number' && Number.isNaN(value))) return null
    const meta = handle.columns[column]
    return value === '' && meta && columnValueKind(meta.dataType, null) !== 'text' ? null : value
  }

  function payload(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [name, column] of Object.entries(handle.columns)) {
      const value = handle.data[name]
      if (handle.mode === 'create' ? column.creatable && value !== undefined && value !== null : column.updatable && !same(value, saved[name])) {
        out[name] = value
      }
    }
    return out
  }

  const handle: RecordHandle = reactive({
    kind: 'RECORD',
    data: {},
    mode: 'create',
    dirty: false,
    restsInView: false,
    status: 'idle',
    error: null,
    columns: {},
    pk: null,
    primaryKey: null,
    set(column: string, value: unknown) {
      handle.data[column] = emptyAsNull(column, value)
      // Edited: the error PostgreSQL gave for it no longer applies.
      if (handle.error?.errors.some(e => e.field === column)) {
        const rest = handle.error.errors.filter(e => e.field !== column)
        handle.error = rest.length ? { errors: rest } : null
      }
      handle.dirty = dataDirty() || linesPending()
    },
    canEdit(column: string) {
      const meta = handle.columns[column]
      if (!meta || handle.mode === 'view' || reading.value) return false
      return handle.mode === 'create' ? meta.creatable : meta.updatable
    },
    async save(values?: Record<string, unknown>) {
      // Values given to save() apply only if it saves: a failure leaves the record as it was.
      const before = copy(handle.data)
      for (const [column, value] of Object.entries(values ?? {})) handle.data[column] = emptyAsNull(column, value)
      const restore = () => {
        handle.data = before
      }
      if (handle.mode === 'view') {
        restore()
        return false
      }
      const body = payload()
      // A range whose From is past its To is never sent (M28-5): its field says so - PostgreSQL would refuse it in English.
      const ranges = rangeErrors(Object.values(handle.columns), body, { ...FORM_MESSAGES, rangeOrder: text('dataviews.record.rangeOrder', 'From is after To.') })
      if (ranges.length) {
        restore()
        fail({ errors: ranges.map(e => ({ code: 'VALIDATION_FAILED', field: e.field, message: e.message })) })
        return false
      }
      if (await emit('before:save', { data: copy(body) }) === false) {
        restore()
        return false
      }
      const withLines = linesPending() && transport.saveTogether && transport.table
      if (handle.mode === 'edit' && Object.keys(body).length === 0 && !withLines) {
        handle.dirty = false
        return true
      }
      handle.status = 'pending'
      handle.error = null
      try {
        const row = withLines
          ? await saveTogether(body)
          : handle.mode === 'create' ? await transport.create(body) : await transport.update(handle.pk, body)
        if (withLines) for (const l of lines) l.saved()
        handle.status = 'success'
        load(row, handle.restsInView ? 'view' : 'edit')
        emit('save', { data: copy(row) })
        return true
      } catch (error) {
        restore()
        fail(error)
        return false
      }
    },
    cancel() {
      handle.data = copy(saved)
      for (const l of lines) l.discard()
      handle.dirty = false
      handle.error = null
      if (handle.mode === 'edit' && handle.restsInView) handle.mode = 'view'
    },
    new(values?: Record<string, unknown>) {
      // What PostgreSQL's constant DEFAULTs would store, shown from the start (a switch DEFAULT true starts on) - the values given win.
      const defaults = Object.fromEntries(Object.values(handle.columns)
        .filter(column => column.creatable && column.literalDefault !== undefined)
        .map(column => [column.name, column.literalDefault]))
      load({ ...defaults, ...(values ?? {}) }, 'create')
    },
    async reload() {
      if (handle.pk === null || handle.pk === undefined) return
      handle.status = 'pending'
      reading.value = true
      try {
        const row = await transport.read(handle.pk)
        reading.value = false
        handle.status = 'success'
        if (row) {
          load(row, handle.mode === 'view' ? 'view' : 'edit')
        } else {
          options.notify?.(text('dataviews.record.noLongerExists', 'The record no longer exists.'), 'error')
          handle.new()
        }
      } catch (error) {
        reading.value = false
        fail(error)
      }
    },
    async open(pk: unknown, view = false, row?: Record<string, unknown>) {
      if (pk === null || pk === undefined || pk === '') {
        handle.new()
        return
      }
      // Another record: never the last one's values while this one loads - the row given, or nothing.
      if (!same(pk, handle.pk)) {
        handle.data = row ? copy(row) : {}
        saved = row ? copy(row) : {}
        handle.dirty = false
        handle.error = null
      }
      handle.pk = pk
      handle.mode = view ? 'view' : 'edit'
      handle.restsInView = view
      if (!row) {
        await handle.reload()
        return
      }
      try {
        const fresh = await transport.read(pk)
        if (!same(pk, handle.pk)) return // another one was opened meanwhile.
        if (!fresh) {
          options.notify?.(text('dataviews.record.noLongerExists', 'The record no longer exists.'), 'error')
          handle.new()
          return
        }
        mergeKeepingEdits(fresh)
        emit('load', { data: copy(handle.data) })
      } catch (error) {
        fail(error)
      }
    },
    async refresh() {
      if (handle.pk === null || handle.pk === undefined) return
      try {
        const row = await transport.read(handle.pk)
        if (!row) return
        mergeKeepingEdits(row)
      } catch (error) {
        fail(error)
      }
    },
    async delete() {
      if (handle.pk === null || handle.pk === undefined) return false
      if (options.confirm && !await options.confirm(text('dataviews.record.deleteConfirm', 'Delete this record? This cannot be undone.'))) return false
      try {
        await transport.remove(handle.pk)
        options.notify?.(text('dataviews.record.deleted', 'Deleted.'), 'success')
        handle.new()
        return true
      } catch (error) {
        fail(error)
        return false
      }
    },
    edit() {
      if (handle.mode === 'view') handle.mode = 'edit'
    },
    clone() {
      const values = Object.fromEntries(Object.entries(handle.data).filter(([name]) => !handle.columns[name]?.generated && name !== primaryKey))
      handle.new(values)
    },
    close() {
      options.close?.()
    },
    attach(attached: RecordLines) {
      lines.add(attached)
      return () => {
        lines.delete(attached)
        handle.linesChanged()
      }
    },
    linesChanged() {
      handle.dirty = dataDirty() || linesPending()
    }
  }) as RecordHandle

  /**
   * The record and its lines in one transaction: the header first when it has something to write (a new record:
   * its insert, the lines taking its key as `$header.<key>`), then every line's writes. Returns the record's row
   * read again after them all - what a trigger recomputed from the lines (a total) shows up.
   */
  async function saveTogether(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const table = transport.table!
    const creating = handle.mode === 'create'
    const header: RecordWriteOperation[] = creating
      ? [{ key: 'header', operation: 'insert', schema: table.schema, table: table.name, data: body }]
      : Object.keys(body).length > 0 ? [{ key: 'header', operation: 'update', schema: table.schema, table: table.name, id: handle.pk, data: body }] : []
    const recordKey = creating ? `$header.${primaryKey}` : handle.pk
    const results = await transport.saveTogether!([...header, ...[...lines].flatMap(l => l.operations(recordKey))])
    const pk = results.header && primaryKey ? results.header[primaryKey] : handle.pk
    return (await transport.read(pk)) ?? results.header ?? copy(saved)
  }

  /** Loads the catalog, then the row `pk` (or a new record); `view` opens it read-only until edit(). */
  async function start(pk?: unknown, view = false) {
    handle.status = 'pending'
    try {
      const catalog = await transport.catalog()
      if (catalog.catalog.primaryKey.length !== 1) throw new Error(text('dataviews.record.singlePrimaryKey', 'A record needs a table with a single-column primary key.'))
      primaryKey = catalog.catalog.primaryKey[0]!
      handle.primaryKey = primaryKey
      handle.columns = recordColumns(catalog)
      handle.status = 'idle'
    } catch (error) {
      fail(error)
      return
    }
    await handle.open(pk, view)
  }

  return { handle, start }
}

/**
 * Whether an edit is in progress - what a record form's frame shows only
 * Cancel and Save for: unsaved changes, a new record, or a record opened
 * read-only that Edit made editable. A record that rests editable (a grid's
 * row, a Master-detail) keeps its other actions until something changes.
 */
export function isEditing(record: Pick<RecordHandle, 'mode' | 'dirty' | 'restsInView'>): boolean {
  if (record.mode === 'view') return false
  return record.dirty || record.mode === 'create' || record.restsInView
}
