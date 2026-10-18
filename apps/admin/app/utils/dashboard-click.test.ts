import { describe, expect, it } from 'vitest'
import { resolveClickFilter, resolveDashboardClick } from '~/utils/dashboard-click'
import type { DashboardFormulaScope } from '~/utils/dashboard-formula'

const scope: DashboardFormulaScope = {
  vars: { periodo: { value: 'this_month', label: 'This month' }, sucursal: { value: null, label: '' } },
  user: null,
  row: { sucursal: 'norte', total: 1200, _id: 'a/b 7', vacio: null },
  rows: []
}

describe('resolveDashboardClick() (D6)', () => {
  it('sets a variable from the clicked row', () => {
    expect(resolveDashboardClick({ action: 'FILTER', variable: 'sucursal', value: '{{row.sucursal}}' }, scope)).toEqual({ kind: 'filter', variable: 'sucursal', value: 'norte' })
  })

  it('opens a DataView filtered - an empty value drops its condition', () => {
    const action = resolveDashboardClick({ action: 'DATAVIEW', dataview: 'dv-1', filter: { sucursal: { _eq: '{{row.sucursal}}' }, otra: { _eq: '{{row.vacio}}' }, total: { _gte: '{{row.total}}' } } }, scope)
    expect(action).toEqual({ kind: 'route', path: '/app/dataviews/dv-1', query: { filter: JSON.stringify({ sucursal: { _eq: 'norte' }, total: { _gte: '1200' } }) } })
    expect(resolveClickFilter({ _and: [{ a: { _eq: '{{row.vacio}}' } }], b: { _null: true } }, scope)).toEqual({ b: { _null: true } })
  })

  it('opens a dashboard with its variables and tab, a record by its key, a URL with its values encoded', () => {
    expect(resolveDashboardClick({ action: 'DASHBOARD', dashboard: 'd-2', variables: { sucursal: '{{row.sucursal}}', periodo: '{{vars.periodo}}' }, tab: 'detalle' }, scope))
      .toEqual({ kind: 'route', path: '/app/dashboards/d-2', query: { sucursal: 'norte', periodo: 'this_month', tab: 'detalle' } })
    expect(resolveDashboardClick({ action: 'RECORD', dataview: 'dv-1', pk: '{{row._id}}' }, scope)).toEqual({ kind: 'route', path: '/app/dataviews/dv-1', query: { pk: 'a/b 7' } })
    expect(resolveDashboardClick({ action: 'RECORD', dataview: 'dv-1', pk: '{{row.vacio}}' }, scope)).toBeNull()
    expect(resolveDashboardClick({ action: 'URL', url: 'https://site.example/o/{{row._id}}', newTab: true }, scope)).toEqual({ kind: 'url', href: 'https://site.example/o/a%2Fb%207', newTab: true })
  })
})
