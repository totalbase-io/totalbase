import { describe, expect, it, vi } from 'vitest'
import { checkValueShape, createRecord, isEditing, literalDefault, recordColumns, type RecordCatalog, type RecordTransport } from '~/utils/record-engine'

const column = (name: string, extra: Partial<RecordCatalog['catalog']['columns'][number]> = {}) =>
  ({ name, dataType: 'text', nullable: true, isIdentity: false, isGenerated: false, defaultExpression: null, ...extra })

const CATALOG: RecordCatalog = {
  catalog: {
    columns: [
      column('id', { dataType: 'bigint', nullable: false, isIdentity: true }),
      column('razon_social', { nullable: false }),
      column('cuit'),
      column('estado', { nullable: false, defaultExpression: '\'ACTIVO\'::text' }),
      column('vendedor', { dataType: 'bigint' }),
      column('total', { dataType: 'numeric', isGenerated: true })
    ],
    primaryKey: ['id'],
    relations: [{ sourceColumn: 'vendedor', targetSchema: 'public', targetTable: 'vendedores', targetColumn: 'id' }]
  },
  writable: { create: ['id', 'razon_social', 'cuit', 'estado', 'vendedor', 'total'], update: ['razon_social', 'estado'] }
}

function transport(overrides: Partial<RecordTransport> = {}): RecordTransport {
  return {
    catalog: async () => CATALOG,
    read: vi.fn(async pk => ({ id: pk, razon_social: 'ACME', cuit: '20-1', estado: 'ACTIVO', vendedor: 3, total: 10 })),
    create: vi.fn(async data => ({ id: 99, estado: 'ACTIVO', total: 0, cuit: null, vendedor: null, ...data })),
    update: vi.fn(async (pk, data) => ({ id: pk, razon_social: 'ACME', cuit: '20-1', estado: 'ACTIVO', vendedor: 3, total: 10, ...data })),
    remove: vi.fn(async () => {}),
    ...overrides
  }
}

describe('recordColumns()', () => {
  it('reads what PostgreSQL requires and writes, and what the viewer may write', () => {
    const columns = recordColumns(CATALOG)
    expect(columns.razon_social).toMatchObject({ required: true, creatable: true, updatable: true })
    // A default or an identity means no value is required.
    expect(columns.estado!.required).toBe(false)
    expect(columns.id).toMatchObject({ required: false, generated: true, creatable: false, updatable: false })
    // A serial key - a default, not an identity: PostgreSQL assigns it, so nobody types it on a new record either.
    const serial = recordColumns({ ...CATALOG, catalog: { ...CATALOG.catalog, columns: CATALOG.catalog.columns.map(c => (c.name === 'id' ? { ...c, isIdentity: false, defaultExpression: 'nextval(\'s\'::regclass)' } : c)) } })
    expect(serial.id).toMatchObject({ generated: false, creatable: false, updatable: false })
    expect(columns.total).toMatchObject({ generated: true, creatable: false })
    // No UPDATE grant on cuit.
    expect(columns.cuit).toMatchObject({ creatable: true, updatable: false })
    expect(columns.vendedor!.foreignKey).toEqual({ schema: 'public', table: 'vendedores', column: 'id' })
  })
})

describe('checkValueShape() and a date DEFAULT of today (T61)', () => {
  it('turns a CHECK list value into the shape the Data API reads its column', () => {
    expect(checkValueShape('21', 'integer')).toBe(21)
    expect(checkValueShape('21', 'numeric(5,2)')).toBe('21.00')
    expect(checkValueShape('10.5', 'numeric')).toBe('10.5')
    expect(checkValueShape('9007199254740993', 'bigint')).toBe('9007199254740993')
    expect(checkValueShape('OPEN', 'text')).toBe('OPEN')
  })
  it('starts a date column defaulting to CURRENT_DATE on today - a timestamp\'s now() stays PostgreSQL\'s', () => {
    expect(literalDefault('CURRENT_DATE', 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(literalDefault('now()', 'timestamp with time zone')).toBeUndefined()
  })
})

describe('literalDefault()', () => {
  it('reads a constant DEFAULT - quoted with its cast, a boolean, a number - and nothing else', () => {
    expect(literalDefault('\'CELULAR\'::text')).toBe('CELULAR')
    expect(literalDefault('\'it\'\'s\'::character varying')).toBe('it\'s')
    expect(literalDefault('true')).toBe(true)
    expect(literalDefault('30')).toBe(30)
    expect(literalDefault('(-1.5)::numeric')).toBe(-1.5)
    expect(literalDefault('now()')).toBeUndefined()
    expect(literalDefault('nextval(\'s\'::regclass)')).toBeUndefined()
    expect(literalDefault(null)).toBeUndefined()
  })
})

describe('a column\'s CHECK list and constant DEFAULT', () => {
  it('reads each CHECK list on its own - one that is not a list never hides the others', () => {
    const columns = recordColumns({
      ...CATALOG,
      catalog: {
        ...CATALOG.catalog,
        checkConstraints: [
          { expression: 'CHECK ((estado = ANY (ARRAY[\'ACTIVO\'::text, \'BAJA\'::text])))' },
          { expression: 'CHECK (((estado = \'BAJA\'::text) = (cuit IS NULL)))' }
        ]
      }
    })
    expect(columns.estado!.values).toEqual(['ACTIVO', 'BAJA'])
    expect(columns.cuit!.values).toBeNull()
  })

  it('starts a new record with what the constant DEFAULTs would store', async () => {
    const { handle, start } = createRecord({ transport: transport() })
    await start()
    expect(handle.data.estado).toBe('ACTIVO')
    expect(handle.dirty).toBe(false)
  })
})

describe('createRecord()', () => {
  it('starts new without a key, and creates with the values set of the columns the viewer may create', async () => {
    const t = transport()
    const emit = vi.fn()
    const { handle, start } = createRecord({ transport: t, emit })
    await start()
    expect(handle.mode).toBe('create')
    handle.set('razon_social', 'Nueva')
    handle.set('total', 5)
    expect(handle.dirty).toBe(true)
    expect(await handle.save()).toBe(true)
    expect(t.create).toHaveBeenCalledWith({ estado: 'ACTIVO', razon_social: 'Nueva' })
    expect(handle).toMatchObject({ mode: 'edit', pk: 99, dirty: false, status: 'success' })
    expect(emit).toHaveBeenCalledWith('save', { data: expect.objectContaining({ id: 99, razon_social: 'Nueva' }) })
  })

  it('never sends a range whose From is past its To - the field says so (M28-5)', async () => {
    const withRange = { ...CATALOG, catalog: { ...CATALOG.catalog, columns: [...CATALOG.catalog.columns, column('periodo', { dataType: 'daterange' })] }, writable: { ...CATALOG.writable, create: [...CATALOG.writable.create, 'periodo'] } }
    const t = transport({ catalog: async () => withRange })
    const notify = vi.fn()
    const { handle, start } = createRecord({ transport: t, notify, showsField: () => true })
    await start()
    handle.set('razon_social', 'Nueva')
    handle.set('periodo', '[2026-05-01,2026-01-01)')
    expect(await handle.save()).toBe(false)
    expect(t.create).not.toHaveBeenCalled()
    expect(handle.error?.errors).toEqual([{ code: 'VALIDATION_FAILED', field: 'periodo', message: 'From is after To.' }])
    expect(notify).not.toHaveBeenCalled()
    handle.set('periodo', '[2026-01-01,2026-05-01)')
    expect(await handle.save()).toBe(true)
  })

  it('keeps its fields closed while a row is read - nothing typed then is lost - and never shows the last record\'s values', async () => {
    let arrive: (row: Record<string, unknown>) => void = () => {}
    const t = transport({
      read: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
        arrive = resolve
      }))
    })
    const { handle, start } = createRecord({ transport: t })
    await start()
    handle.set('razon_social', 'Escrito antes')
    const opening = handle.open(8)
    expect(handle.data).toEqual({})
    expect(handle.canEdit('razon_social')).toBe(false)
    arrive({ id: 8, razon_social: 'Leída', cuit: '20-2', estado: 'ACTIVO', vendedor: 3, total: 1 })
    await opening
    expect(handle.canEdit('razon_social')).toBe(true)
    expect(handle.data.razon_social).toBe('Leída')
  })

  it('opened with the row a list already holds, shows it editable at once - the read keeps what was typed meanwhile', async () => {
    let arrive: (row: Record<string, unknown>) => void = () => {}
    const t = transport({
      read: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
        arrive = resolve
      }))
    })
    const { handle, start } = createRecord({ transport: t })
    await start()
    const opening = handle.open(8, false, { 'id': 8, 'razon_social': 'De la grilla', 'estado': 'ACTIVO', 'vendedor.nombre': 'Ana' })
    // No empty, locked form while it loads.
    expect(handle.data).toMatchObject({ razon_social: 'De la grilla', estado: 'ACTIVO' })
    expect(handle.canEdit('razon_social')).toBe(true)
    handle.set('estado', 'BAJA')
    arrive({ id: 8, razon_social: 'Leída', cuit: '20-2', estado: 'ACTIVO', vendedor: 3, total: 1 })
    await opening
    // Untouched values take the read's; the edit stays, and is what a save sends.
    expect(handle.data).toMatchObject({ razon_social: 'Leída', cuit: '20-2', estado: 'BAJA' })
    expect(handle.dirty).toBe(true)
    await handle.save()
    expect(t.update).toHaveBeenCalledWith(8, { estado: 'BAJA' })
  })
  it('loads a row by its key, and updates only what changed', async () => {
    const t = transport()
    const { handle, start } = createRecord({ transport: t })
    await start(7)
    expect(t.read).toHaveBeenCalledWith(7)
    expect(handle).toMatchObject({ mode: 'edit', pk: 7, dirty: false })
    expect(handle.canEdit('razon_social')).toBe(true)
    expect(handle.canEdit('cuit')).toBe(false)
    expect(await handle.save()).toBe(true)
    expect(t.update).not.toHaveBeenCalled()
    expect(await handle.save({ estado: 'BAJA' })).toBe(true)
    expect(t.update).toHaveBeenCalledWith(7, { estado: 'BAJA' })
  })

  it('saves an emptied number input as null - "" stays a value only in a text column (M25)', async () => {
    const t = transport({ catalog: async () => ({ ...CATALOG, writable: { ...CATALOG.writable, update: ['razon_social', 'cuit', 'vendedor', 'estado'] } }) })
    const { handle, start } = createRecord({ transport: t })
    await start(7)
    handle.set('vendedor', '')
    handle.set('cuit', '')
    // UInputNumber empties to undefined: still a change to null, never dropped from the request.
    handle.set('estado', undefined)
    expect(handle.data.vendedor).toBeNull()
    expect(await handle.save()).toBe(true)
    expect(t.update).toHaveBeenCalledWith(7, { vendedor: null, cuit: '', estado: null })
    handle.set('vendedor', Number.NaN)
    expect(handle.data.vendedor).toBeNull()
  })

  it('leaves the record as it was when a save fails, and keeps the API\'s errors', async () => {
    const failure = Object.assign(new Error('duplicate'), { errors: [{ code: 'UNIQUE_VIOLATION', message: 'duplicate' }] })
    const notify = vi.fn()
    const { handle, start } = createRecord({ transport: transport({
      update: async () => {
        throw failure
      }
    }), notify })
    await start(7)
    expect(await handle.save({ razon_social: 'Otra' })).toBe(false)
    expect(handle.data.razon_social).toBe('ACME')
    expect(handle.error).toEqual({ errors: [{ code: 'UNIQUE_VIOLATION', message: 'duplicate' }] })
    expect(notify).toHaveBeenCalledWith('duplicate', 'error')
  })

  it('shows an error about a column on its field, not as a notice - until that column is edited', async () => {
    const failure = Object.assign(new Error('x'), { errors: [
      { code: 'NOT_NULL_VIOLATION', message: 'null value in column "razon_social"', field: 'razon_social' },
      { code: 'CHECK_VIOLATION', message: 'cuit invalid', field: 'cuit' }
    ] })
    const notify = vi.fn()
    const { handle, start } = createRecord({ transport: transport({
      create: async () => {
        throw failure
      }
    }), notify, showsField: column => column === 'razon_social' })
    await start(undefined)
    handle.new()
    expect(await handle.save()).toBe(false)
    // razon_social has its field on screen; cuit doesn't - its error is a notice.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('cuit invalid', 'error')
    handle.set('razon_social', 'ACME')
    expect(handle.error?.errors.map(e => e.field)).toEqual(['cuit'])
  })

  it('returns a record opened read-only to reading once saved or cancelled', async () => {
    const { handle, start } = createRecord({ transport: transport() })
    await start(7, true)
    expect(handle.mode).toBe('view')
    handle.edit()
    handle.set('razon_social', 'Otra')
    handle.cancel()
    expect(handle).toMatchObject({ mode: 'view', dirty: false })
    expect(handle.data.razon_social).toBe('ACME')
    handle.edit()
    handle.set('razon_social', 'Otra')
    expect(await handle.save()).toBe(true)
    expect(handle.mode).toBe('view')
    // Opened editable, it stays editable.
    await handle.open(8)
    handle.set('razon_social', 'Otra')
    await handle.save()
    expect(handle.mode).toBe('edit')
  })

  it('lets before:save cancel, opens read-only in view mode until edit()', async () => {
    const t = transport()
    const { handle, start } = createRecord({ transport: t, emit: event => (event === 'before:save' ? false : undefined) })
    await start(7, true)
    expect(handle.canEdit('razon_social')).toBe(false)
    expect(await handle.save({ razon_social: 'X' })).toBe(false)
    handle.edit()
    expect(await handle.save({ razon_social: 'X' })).toBe(false)
    expect(handle.data.razon_social).toBe('ACME')
    expect(t.update).not.toHaveBeenCalled()
  })

  it('cancels edits, clones without its key and generated columns, and deletes after a confirmation', async () => {
    const t = transport()
    const { handle, start } = createRecord({ transport: t, confirm: () => true })
    await start(7)
    handle.set('razon_social', 'Cambiada')
    handle.cancel()
    expect(handle).toMatchObject({ dirty: false, data: expect.objectContaining({ razon_social: 'ACME' }) })
    handle.clone()
    expect(handle.mode).toBe('create')
    expect(handle.data).toEqual({ razon_social: 'ACME', cuit: '20-1', estado: 'ACTIVO', vendedor: 3 })
    await start(7)
    expect(await handle.delete()).toBe(true)
    expect(t.remove).toHaveBeenCalledWith(7)
    expect(handle.mode).toBe('create')
  })

  it('refreshes what PostgreSQL recomputed, keeping the edits in progress', async () => {
    let total = 10
    const t = transport({ read: async pk => ({ id: pk, razon_social: 'ACME', cuit: '20-1', estado: 'ACTIVO', vendedor: 3, total }) })
    const { handle, start } = createRecord({ transport: t })
    await start(7)
    handle.set('razon_social', 'Escribiendo…')
    total = 25 // a trigger, after a detail row changed
    await handle.refresh()
    expect(handle.data).toMatchObject({ razon_social: 'Escribiendo…', total: 25 })
    expect(handle.dirty).toBe(true)
  })

  it('opens another row by its key, read-only when asked', async () => {
    const t = transport()
    const { handle, start } = createRecord({ transport: t })
    await start(7)
    await handle.open(8, true)
    expect(t.read).toHaveBeenLastCalledWith(8)
    expect(handle).toMatchObject({ pk: 8, mode: 'view' })
    await handle.open(null)
    expect(handle.mode).toBe('create')
  })

  it('refuses a table without a single-column primary key', async () => {
    const { handle, start } = createRecord({ transport: transport({ catalog: async () => ({ ...CATALOG, catalog: { ...CATALOG.catalog, primaryKey: [] } }) }) })
    await start()
    expect(handle.status).toBe('error')
    expect(handle.error!.errors[0]!.message).toMatch(/single-column primary key/)
  })
})

describe('isEditing()', () => {
  it('is an edit in progress: changes, a new record, or Edit on a record opened read-only', () => {
    expect(isEditing({ mode: 'view', dirty: false, restsInView: true })).toBe(false)
    expect(isEditing({ mode: 'edit', dirty: false, restsInView: true })).toBe(true)
    expect(isEditing({ mode: 'edit', dirty: false, restsInView: false })).toBe(false)
    expect(isEditing({ mode: 'edit', dirty: true, restsInView: false })).toBe(true)
    expect(isEditing({ mode: 'create', dirty: false, restsInView: false })).toBe(true)
  })
})

// A record and its lines saved together (DataViews.md §6.6, T51).
describe('lines saved with the record', () => {
  const lineWrites = (ops: (key: unknown) => { key: string, operation: 'insert' | 'update' | 'delete', schema: string, table: string, id?: unknown, data?: Record<string, unknown> }[]) => {
    let pending = true
    return {
      pending: () => pending,
      operations: vi.fn(ops),
      saved: vi.fn(() => { pending = false }),
      discard: vi.fn(() => { pending = false })
    }
  }
  const table = { schema: 'public', name: 'facturas' }

  it('sends the header and the lines in one transaction - a new record\'s lines taking its key as $header.<key>', async () => {
    const saveTogether = vi.fn(async () => ({ header: { id: 50, razon_social: 'Acme', estado: 'ACTIVO', total: 30 }, line1: { id: 1 } }))
    const t = transport({ table, saveTogether })
    const { handle, start } = createRecord({ transport: t })
    await start()
    const lines = lineWrites(key => [{ key: 'line1', operation: 'insert', schema: 'public', table: 'items', data: { factura: key, cantidad: 3 } }])
    handle.attach(lines)
    handle.set('razon_social', 'Acme')
    expect(handle.dirty).toBe(true)
    expect(await handle.save()).toBe(true)
    expect(saveTogether).toHaveBeenCalledWith([
      { key: 'header', operation: 'insert', schema: 'public', table: 'facturas', data: { razon_social: 'Acme', estado: 'ACTIVO' } },
      { key: 'line1', operation: 'insert', schema: 'public', table: 'items', data: { factura: '$header.id', cantidad: 3 } }
    ])
    expect(t.create).not.toHaveBeenCalled()
    expect(lines.saved).toHaveBeenCalled()
    // Read again after the lines - what their trigger recomputed (a total) shows up.
    expect(t.read).toHaveBeenCalledWith(50)
    expect(handle).toMatchObject({ mode: 'edit', pk: 50, dirty: false })
  })

  it('with only its lines changed: no header write, the record read again', async () => {
    const saveTogether = vi.fn(async () => ({ line1: { id: 1 } }))
    const t = transport({ table, saveTogether })
    const { handle, start } = createRecord({ transport: t })
    await start(7)
    handle.attach(lineWrites(() => [{ key: 'line1', operation: 'delete', schema: 'public', table: 'items', id: 1 }]))
    handle.linesChanged()
    expect(handle.dirty).toBe(true)
    expect(await handle.save()).toBe(true)
    expect(saveTogether).toHaveBeenCalledWith([{ key: 'line1', operation: 'delete', schema: 'public', table: 'items', id: 1 }])
    expect(t.read).toHaveBeenCalledTimes(2)
  })

  it('cancel drops the lines\' changes too; a failure keeps them for another try', async () => {
    const saveTogether = vi.fn(async () => {
      throw new Error('nope')
    })
    const { handle, start } = createRecord({ transport: transport({ table, saveTogether }) })
    await start(7)
    const lines = lineWrites(() => [{ key: 'line1', operation: 'update', schema: 'public', table: 'items', id: 1, data: { cantidad: 2 } }])
    handle.attach(lines)
    expect(await handle.save()).toBe(false)
    expect(lines.saved).not.toHaveBeenCalled()
    handle.cancel()
    expect(lines.discard).toHaveBeenCalled()
  })
})
