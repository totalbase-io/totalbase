import { describe, expect, it } from 'vitest'
import type { CustomAction } from '@totalbase/tb-catalog'
import { actionFlags, actionInput, actionsAt, fillText, runnableActions } from '~/utils/custom-actions'

// A DataView's custom actions (DataViews.md §3.7, T72).
describe('custom actions', () => {
  const issue: CustomAction = { id: 'issue', label: 'Issue', target: { kind: 'FUNCTION', resource: '00000000-0000-0000-0000-000000000001' }, args: { factura: '{{id}}' }, places: ['row', 'record'], where: { estado: { _eq: 'BORRADOR' } } }
  const remind: CustomAction = { id: 'remind', label: 'Remind', target: { kind: 'WORKFLOW', workflow: '00000000-0000-0000-0000-000000000002' }, places: ['selection'] }
  const hidden: CustomAction = { id: 'hidden', label: 'Hidden', target: { kind: 'WORKFLOW', workflow: '00000000-0000-0000-0000-000000000003' }, places: ['row'] }
  const runnable = runnableActions({ custom_actions: [issue, remind, hidden] }, {
    issue: { kind: 'FUNCTION', schema: 'public', name: 'emitir' },
    remind: { kind: 'WORKFLOW', slug: 'recordatorio' }
  })

  it('keeps only the actions the viewer may run, in order', () => {
    expect(runnable.map(r => r.action.id)).toEqual(['issue', 'remind'])
  })

  it('sends a condition as a flag, and shows a row\'s action only where it holds', () => {
    expect(actionFlags(runnable, ['row'])).toEqual({ a_issue: { estado: { _eq: 'BORRADOR' } } })
    expect(actionsAt(runnable, 'row', ['a_issue']).map(r => r.action.id)).toEqual(['issue'])
    expect(actionsAt(runnable, 'row', [])).toEqual([])
    expect(actionsAt(runnable, 'selection').map(r => r.action.id)).toEqual(['remind'])
  })

  it('fills its arguments from the row - a whole {{column}} typed, {{ids}} the selection, text filled - else the key', () => {
    const rows = [{ id: 7, numero: 12, tipo: 'A' }, { id: 8, numero: 13, tipo: 'B' }]
    expect(actionInput(issue, rows.slice(0, 1), 'id')).toEqual({ factura: 7 })
    expect(actionInput({ ...issue, args: { lista: '{{ids}}', nota: 'Factura {{tipo}} {{numero}}', fijo: 'X' } }, rows, 'id')).toEqual({ lista: [7, 8], nota: 'Factura A 12', fijo: 'X' })
    expect(actionInput(remind, rows, 'id')).toEqual({ ids: [7, 8] })
    expect(actionInput(remind, rows.slice(1), 'id')).toEqual({ id: 8 })
    expect(fillText('¿Emitir {{tipo}} {{numero}}?', rows[0])).toBe('¿Emitir A 12?')
  })
})
