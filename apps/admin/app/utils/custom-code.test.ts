import { describe, expect, it, vi } from 'vitest'
import { compileCustomCode, declaredFunctions, handlerName, handlerScaffold, handlerWithBody, rowsChangedHandler, runHandler, withoutUntouchedHandler } from '~/utils/custom-code'

describe('declaredFunctions()', () => {
  it('lists the top-level functions, whatever their form', () => {
    const code = `
function onLoad(dataview) {}
async function onCashClick(dataview, event) {}
const onChange = (dataview) => {}
let helper = async (x) => x
const total = 3
`
    expect(declaredFunctions(code)).toEqual(['onLoad', 'onCashClick', 'onChange', 'helper'])
  })
})

describe('compileCustomCode() and runHandler()', () => {
  it('awaits an async handler and passes its arguments', async () => {
    const compiled = compileCustomCode('async function onClick(dataview, event) { await null; return dataview.n + event.n }', ['onClick'])
    expect(await runHandler(compiled, 'onClick', [{ n: 1 }, { n: 2 }], vi.fn())).toBe(3)
  })

  it('reports a handler that throws instead of breaking the page', async () => {
    const onError = vi.fn()
    const compiled = compileCustomCode('async function onClick() { throw new Error("boom") }', ['onClick'])
    expect(await runHandler(compiled, 'onClick', [], onError)).toBeUndefined()
    expect(onError).toHaveBeenCalledWith('onClick: boom')
  })

  it('reports code that does not compile, and ignores names that are not identifiers', () => {
    expect(compileCustomCode('function (', ['x']).error).toBeTruthy()
    expect(compileCustomCode('function a() {}', ['a); alert(1); (b']).functions).toEqual({})
  })
})

describe('handlerName() and handlerScaffold()', () => {
  it('names a handler after its owner and event, never reusing a name', () => {
    expect(handlerName('emitir', 'success', [])).toBe('onEmitirSuccess')
    expect(handlerName('Button', 'update:modelValue', ['onButtonUpdateModelValue'])).toBe('onButtonUpdateModelValue2')
  })

  it('scaffolds an async function', () => {
    expect(handlerScaffold('onEmitirSuccess', 'Runs when emitir succeeds', '{ result }')).toContain('async function onEmitirSuccess(dataview, event)')
  })
})

describe('handlerWithBody()', () => {
  it('wraps a snippet\'s lines as a handler, indented, and it compiles', () => {
    const code = handlerWithBody('onGuardarClick', 'Runs on "Click" of guardar', undefined, ['if (!await dataview.vars.record.save()) return', 'dataview.vars.record.new()'])
    expect(code).toBe('\n// Runs on "Click" of guardar.\nasync function onGuardarClick(dataview, event) {\n  if (!await dataview.vars.record.save()) return\n  dataview.vars.record.new()\n}\n')
    expect(declaredFunctions(code)).toEqual(['onGuardarClick'])
  })
})

describe('withoutUntouchedHandler()', () => {
  const block = rowsChangedHandler('onDetailRowsChanged')
  const own = 'function onLoad(dataview) {\n  dataview.notify(\'hi\')\n}\n'
  it('takes out the handler as written, and the blank lines it leaves', () => {
    expect(withoutUntouchedHandler(`${own}\n${block}`, 'onDetailRowsChanged', block)).toBe(own)
    expect(withoutUntouchedHandler(`\n\n${block}`, 'onDetailRowsChanged', block)).toBe('')
    expect(withoutUntouchedHandler(`${block}\n${own}`, 'onDetailRowsChanged', block)).toBe(own)
  })
  it('keeps one the author changed or calls from elsewhere', () => {
    const edited = block.replace('refresh()', 'reload()')
    expect(withoutUntouchedHandler(`${own}\n${edited}`, 'onDetailRowsChanged', block)).toBe(`${own}\n${edited}`)
    const called = `${own.replace('notify(\'hi\')', 'onDetailRowsChanged(dataview)')}\n${block}`
    expect(withoutUntouchedHandler(called, 'onDetailRowsChanged', block)).toBe(called)
  })
})
