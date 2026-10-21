import type { VariableDefinition } from '@totalbase/tb-catalog'
import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import type { RecordHandle } from '~/utils/record-engine'
import { coerce, createVariablesEngine, formulaTypeFor, type CallHandle, type ResourceHandle, type ValueHandle, type VariablesTransport } from '~/utils/variables-engine'
import { evaluateFormula, loadFormulaFunctions } from '~/utils/formula-engine'

const RESOURCE_ID = '3f0c6a0e-0000-4000-8000-000000000001'

function resource(name: string, query: Record<string, unknown>, extra: Partial<VariableDefinition> = {}): VariableDefinition {
  return { name, kind: 'RESOURCE', resource: RESOURCE_ID, query: { fields: 'id,nombre', ...query }, mode: 'list', immediate: true, watch: true, count: false, ...extra } as VariableDefinition
}

/** A transport whose reads resolve when the test says so, in any order. */
function controlledTransport() {
  const pending: { query: Record<string, unknown>, resolve: (rows: unknown[]) => void }[] = []
  const transport: VariablesTransport = {
    read: (_resource, query) => new Promise(resolve => pending.push({ query, resolve: rows => resolve({ data: rows }) })),
    call: vi.fn(async (_target, input) => ({ ok: true, input }))
  }
  return { transport, pending }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('Values', () => {
  it('start at their default, change through set() with update:value, and reset()', () => {
    const emit = vi.fn()
    const { vars } = createVariablesEngine(
      [{ name: 'cantidad', kind: 'VALUE', type: 'number', default: { source: 'constant', value: 1 } }],
      { transport: controlledTransport().transport, emit }
    )
    const cantidad = vars.cantidad as ValueHandle
    expect(cantidad.value).toBe(1)
    cantidad.set('3')
    expect(cantidad.value).toBe(3)
    expect(emit).toHaveBeenCalledWith('cantidad', 'update:value', { value: 3, previous: 1 })
    cantidad.reset()
    expect(cantidad.value).toBe(1)
  })

  it('refuse a value of the wrong type', () => {
    const { vars } = createVariablesEngine([{ name: 'fecha', kind: 'VALUE', type: 'date' }], { transport: controlledTransport().transport })
    expect(() => (vars.fecha as ValueHandle).set('ayer')).toThrow(/Not a valid date/)
    expect((vars.fecha as ValueHandle).value).toBeNull()
  })

  it('take a formula, URL parameter or $USER default from the host', () => {
    const { vars } = createVariablesEngine(
      [{ name: 'sucursal', kind: 'VALUE', type: 'number', default: { source: 'param', name: 'sucursal' } }],
      { transport: controlledTransport().transport, resolveDefault: () => '7' }
    )
    expect((vars.sucursal as ValueHandle).value).toBe(7)
  })
})

describe('Resources', () => {
  it('load on start with the variables\' values bound into the where, as values', async () => {
    const { transport, pending } = controlledTransport()
    const { vars, start } = createVariablesEngine([
      { name: 'cliente', kind: 'VALUE', type: 'number', default: { source: 'constant', value: 42 } },
      resource('facturas', { where: { cliente: { _eq: '{{vars.cliente.value}}' }, razon: { _ilike: '%{{vars.cliente.value}}%' } } })
    ], { transport })
    const started = start()
    await flush()
    expect(pending[0]!.query).toEqual({ fields: 'id,nombre', where: { cliente: { _eq: 42 }, razon: { _ilike: '%42%' } } })
    pending[0]!.resolve([{ id: 1 }])
    await started
    const facturas = vars.facturas as ResourceHandle
    expect(facturas.data).toEqual([{ id: 1 }])
    expect(facturas.status).toBe('success')
  })

  it('find() reads one row by a column apart, with the query\'s fields and none of its filters - data stays', async () => {
    const { transport, pending } = controlledTransport()
    const { vars, start } = createVariablesEngine([resource('clientes', { where: { activo: { _eq: 'true' } }, order_by: 'nombre', limit: 100 })], { transport })
    void start()
    await flush()
    pending[0]!.resolve([{ id: 1, nombre: 'Ana' }])
    await flush()
    const clientes = vars.clientes as ResourceHandle
    const found = clientes.find('id', 342)
    await flush()
    expect(pending[1]!.query).toEqual({ fields: 'id,nombre', order_by: 'nombre', where: { id: { _eq: 342 } }, limit: 1 })
    pending[1]!.resolve([{ id: 342, nombre: 'Zoe' }])
    expect(await found).toEqual({ id: 342, nombre: 'Zoe' })
    expect(clientes.data).toEqual([{ id: 1, nombre: 'Ana' }])
  })

  it('create() writes a row of its table as the viewer and resolves to it - a select\'s Create', async () => {
    const { transport } = controlledTransport()
    transport.call = vi.fn(async () => ({ id: 7, nombre: 'Nueva' }))
    const { vars } = createVariablesEngine([resource('clientes', {}, { immediate: false })], { transport })
    const created = await (vars.clientes as ResourceHandle).create({ nombre: 'Nueva' })
    expect(transport.call).toHaveBeenCalledWith({ type: 'TABLE', resource: RESOURCE_ID, action: 'CREATE' }, { data: { nombre: 'Nueva' } })
    expect(created).toEqual({ id: 7, nombre: 'Nueva' })
  })

  it('leave out a condition whose variable is unset - an empty filter means no filter', async () => {
    const { transport, pending } = controlledTransport()
    const { start } = createVariablesEngine([
      { name: 'estado', kind: 'VALUE', type: 'text' },
      { name: 'tags', kind: 'VALUE', type: 'array', default: { source: 'constant', value: [] } },
      resource('r', { where: { estado: { _eq: '{{vars.estado.value}}' }, _or: [{ tag: { _in: '{{vars.tags.value}}' } }], activo: { _eq: 'true' } } })
    ], { transport })
    void start()
    await flush()
    expect(pending[0]!.query.where).toEqual({ activo: { _eq: 'true' } })
  })

  it('send a list as the grammar\'s comma-separated values', async () => {
    const { transport, pending } = controlledTransport()
    const { start } = createVariablesEngine([
      { name: 'estados', kind: 'VALUE', type: 'array', default: { source: 'constant', value: ['A', 'B'] } },
      resource('r', { where: { estado: { _in: '{{vars.estados.value}}' } } })
    ], { transport })
    void start()
    await flush()
    expect(pending[0]!.query.where).toEqual({ estado: { _in: 'A,B' } })
  })

  it('turn a date range into bounds: a period stays $PERIOD (PostgreSQL computes it), two dates end the day after', async () => {
    const { transport, pending } = controlledTransport()
    const { vars, start } = createVariablesEngine([
      { name: 'rango', kind: 'VALUE', type: 'date_range', default: { source: 'constant', value: { period: 'this_month' } } },
      resource('r', { where: { fecha: { _gte: '{{vars.rango.from}}', _lt: '{{vars.rango.to}}' } } }, { watch: true })
    ], { transport, debounceMs: 0 })
    void start()
    await flush()
    expect(pending[0]!.query.where).toEqual({ fecha: { _gte: '$PERIOD.this_month.from', _lt: '$PERIOD.this_month.to' } })
    pending[0]!.resolve([])
    await flush()
    ;(vars.rango as ValueHandle).set({ from: '2026-09-01', to: '2026-09-30' })
    await nextTick()
    await flush()
    expect(pending[1]!.query.where).toEqual({ fecha: { _gte: '2026-09-01', _lt: '2026-10-01' } })
  })

  it('refuse a viewer value starting with $ - the grammar would read it as a variable', async () => {
    const { transport, pending } = controlledTransport()
    const emit = vi.fn()
    const { vars, start } = createVariablesEngine([
      { name: 'texto', kind: 'VALUE', type: 'text', default: { source: 'constant', value: '$USER.email' } },
      resource('r', { where: { nombre: { _eq: '{{vars.texto.value}}' } } })
    ], { transport, emit })
    await start()
    expect(pending).toHaveLength(0)
    expect((vars.r as ResourceHandle).status).toBe('error')
    expect(emit).toHaveBeenCalledWith('r', 'error', { error: 'A filter value can\'t start with "$".' })
  })

  it('reload, debounced, when a watched variable changes - and keep only the latest response', async () => {
    const { transport, pending } = controlledTransport()
    const { vars, start } = createVariablesEngine([
      { name: 'q', kind: 'VALUE', type: 'text', default: { source: 'constant', value: 'a' } },
      resource('r', { where: { nombre: { _ilike: '%{{vars.q.value}}%' } } })
    ], { transport, debounceMs: 20 })
    void start()
    await flush()
    pending[0]!.resolve([{ id: 'first' }])
    await flush()

    const q = vars.q as ValueHandle
    q.set('ab')
    await nextTick()
    q.set('abc')
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(pending).toHaveLength(2) // two quick changes, one reload
    expect(pending[1]!.query.where).toEqual({ nombre: { _ilike: '%abc%' } })

    const r = vars.r as ResourceHandle
    void r.refresh()
    await flush()
    pending[2]!.resolve([{ id: 'newest' }])
    await flush()
    pending[1]!.resolve([{ id: 'stale' }]) // the older request answers last
    await flush()
    expect(r.data).toEqual([{ id: 'newest' }])
  })

  it('read the page\'s record by path, and reload only when what the query reads changes', async () => {
    const { transport, pending } = controlledTransport()
    const record = reactive({ kind: 'RECORD', data: { id: 7, nota: 'x' } }) as unknown as RecordHandle
    const { start } = createVariablesEngine([resource('items', { where: { factura: { _eq: '{{vars.record.data.id}}' } } })], { transport, record, debounceMs: 20 })
    void start()
    await flush()
    expect(pending[0]!.query.where).toEqual({ factura: { _eq: 7 } })
    pending[0]!.resolve([])
    record.data.nota = 'y' // a column the query doesn't read
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(pending).toHaveLength(1)
    record.data = { id: 8, nota: 'y' } // another record
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(pending).toHaveLength(2)
    expect(pending[1]!.query.where).toEqual({ factura: { _eq: 8 } })
  })

  it('load record mode as one row, and AND a runtime filter with the designed where', async () => {
    const { transport, pending } = controlledTransport()
    const { vars, start } = createVariablesEngine([
      resource('cliente', { where: { activo: { _eq: 'true' } } }, { mode: 'record' })
    ], { transport })
    void start()
    await flush()
    expect(pending[0]!.query.limit).toBe(1)
    pending[0]!.resolve([{ id: 5 }])
    await flush()
    expect((vars.cliente as ResourceHandle).data).toEqual({ id: 5 })

    void (vars.cliente as ResourceHandle).setFilter({ id: { _eq: '9' } })
    await flush()
    expect(pending[1]!.query.where).toEqual({ _and: [{ activo: { _eq: 'true' } }, { id: { _eq: '9' } }] })
  })

  it('page with the query\'s limit, and let before:load cancel', async () => {
    const { transport, pending } = controlledTransport()
    const emit = vi.fn((_name: string, event: string) => (event === 'before:load' ? false : undefined))
    const { vars } = createVariablesEngine([resource('r', { limit: 20 }, { immediate: false })], { transport, emit })
    await (vars.r as ResourceHandle).setPage(3)
    expect(pending).toHaveLength(0)
    expect(emit).toHaveBeenCalledWith('r', 'before:load', { query: { fields: 'id,nombre', limit: 20, offset: 40 } })
  })

  it('keep its search as state - the query\'s search while set, the designed one again when cleared', async () => {
    const { transport, pending } = controlledTransport()
    const { vars } = createVariablesEngine([resource('r', { limit: 20, search: 'acme' }, { immediate: false })], { transport })
    const r = vars.r as ResourceHandle
    void r.setPage(2)
    await flush()
    void r.setSearch('  aceite ')
    await flush()
    expect(r.search).toBe('aceite')
    expect(r.page).toBe(1)
    expect(pending[1]!.query).toMatchObject({ search: 'aceite' })
    expect(pending[1]!.query.offset).toBeUndefined()
    void r.setSearch('')
    await flush()
    expect(r.search).toBeNull()
    expect(pending[2]!.query.search).toBe('acme')
  })

  it('load dependencies first on start', async () => {
    const order: string[] = []
    const transport: VariablesTransport = {
      read: async (_r, query) => {
        order.push(String(query.fields))
        return { data: [{ id: 1 }] }
      },
      call: async () => null
    }
    const { start } = createVariablesEngine([
      { ...resource('facturas', { fields: 'facturas', where: { cliente: { _eq: '{{vars.clientes.data}}' } } }) } as VariableDefinition,
      resource('clientes', { fields: 'clientes' })
    ], { transport })
    await start()
    expect(order).toEqual(['clientes', 'facturas'])
  })
})

describe('Calls', () => {
  it('run with the designed input resolved, emit success and complete, and keep the result', async () => {
    const { transport } = controlledTransport()
    const emit = vi.fn()
    const { vars } = createVariablesEngine([
      { name: 'cliente', kind: 'VALUE', type: 'number', default: { source: 'constant', value: 7 } },
      { name: 'emitir', kind: 'CALL', target: { type: 'WORKFLOW', workflow: 'wf-1' }, input: { cliente: '{{vars.cliente.value}}', nota: 'hola' } }
    ], { transport, emit })
    const emitir = vars.emitir as CallHandle
    const result = await emitir.execute()
    expect(transport.call).toHaveBeenCalledWith({ type: 'WORKFLOW', workflow: 'wf-1' }, { cliente: 7, nota: 'hola' })
    expect(result).toEqual({ ok: true, input: { cliente: 7, nota: 'hola' } })
    expect(emitir.status).toBe('success')
    expect(emit.mock.calls.map(c => c[1])).toEqual(['before:execute', 'success', 'complete'])
  })

  it('let before:execute replace the input or cancel, and reject on failure with status error', async () => {
    const transport: VariablesTransport = {
      read: async () => ({ data: [] }),
      call: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    let replace: unknown = { x: 1 }
    const { vars } = createVariablesEngine(
      [{ name: 'c', kind: 'CALL', target: { type: 'FUNCTION', resource: RESOURCE_ID } }],
      { transport, emit: (_n, event) => (event === 'before:execute' ? replace : undefined) }
    )
    const c = vars.c as CallHandle
    await expect(c.execute()).rejects.toThrow('boom')
    expect(transport.call).toHaveBeenCalledWith({ type: 'FUNCTION', resource: RESOURCE_ID }, { x: 1 })
    expect(c.status).toBe('error')
    expect(c.error).toEqual({ errors: [{ message: 'boom' }] })
    replace = false
    await c.execute()
    expect(transport.call).toHaveBeenCalledTimes(1)
  })

  it('keep the API\'s errors on a failure - error, the emit and the rejection carry all of them', async () => {
    const apiErrors = [
      { source: 'POSTGRESQL', code: 'NOT_NULL_VIOLATION', message: 'cuit is required.' },
      { source: 'TOTALBASE', code: 'PAYLOAD_CHECK_FAILED', message: 'The total must be positive.' }
    ]
    const failure = Object.assign(new Error(apiErrors[0]!.message), { errors: apiErrors })
    const emit = vi.fn()
    const { vars } = createVariablesEngine(
      [{ name: 'guardar', kind: 'CALL', target: { type: 'TABLE', resource: RESOURCE_ID, action: 'CREATE' } }],
      { transport: { read: async () => ({ data: [] }), call: async () => { throw failure } }, emit }
    )
    const guardar = vars.guardar as CallHandle
    await expect(guardar.execute({ data: {} })).rejects.toMatchObject({ message: 'cuit is required.', errors: apiErrors })
    const expected = { errors: apiErrors.map(e => ({ code: e.code, source: e.source, message: e.message })) }
    expect(guardar.error).toEqual(expected)
    expect(emit).toHaveBeenCalledWith('guardar', 'error', { error: expected })
  })
})

describe('coerce()', () => {
  it('converts what a control naturally produces into the variable type', () => {
    expect(coerce('number', '12.5')).toBe(12.5)
    expect(coerce('boolean', 'false')).toBe(false)
    expect(coerce('text', 3)).toBe('3')
    expect(coerce('date', new Date(2026, 8, 29, 15, 0))).toBe('2026-09-29')
    expect(coerce('number', undefined)).toBeNull()
    expect(() => coerce('number', 'doce')).toThrow()
  })
})

describe('Value defaults by type', () => {
  it('turns a date into the local day, never UTC\'s', () => {
    // 23:30 local on the 5th: in a zone west of UTC that instant is already the 6th in UTC.
    const lateEvening = new Date(2026, 9, 5, 23, 30)
    expect(coerce('date', lateEvening)).toBe('2026-10-05')
  })

  it('evaluates TODAY() for a date Value as YYYY-MM-DD - a date input takes it as is', async () => {
    await loadFormulaFunctions()
    const result = evaluateFormula('TODAY()', { values: {}, returnType: formulaTypeFor('date') })
    expect(result).toMatchObject({ ok: true })
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(result.ok && result.value).toBe(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`)
    expect(coerce('date', result.ok ? result.value : null)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('asks a formula for its Value\'s type', () => {
    expect(formulaTypeFor('timestamp')).toBe('datetime')
    expect(formulaTypeFor('number')).toBe('number')
    expect(formulaTypeFor('json')).toBeUndefined()
  })
})
