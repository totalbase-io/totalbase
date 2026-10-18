import { describe, expect, it } from 'vitest'
import { toDataApiParams, withoutVariables } from '~/utils/data-api-query'

describe('toDataApiParams()', () => {
  it('turns a query object into the parameters the Data API parser reads', () => {
    expect(toDataApiParams({
      fields: 'condicion.nombre',
      where: { fecha: { _gte: '$PERIOD.this_month.from' }, _or: [{ estado: { _eq: 'A' } }] },
      group_by: [['condicion', 'nombre']],
      _sum: { total: 'total' },
      _count: { '*': 'cantidad' },
      limit: 20,
      count: true
    })).toEqual({
      'fields': 'condicion.nombre',
      'where[fecha][_gte]': '$PERIOD.this_month.from',
      'where[_or][0][estado][_eq]': 'A',
      'group_by': 'condicion.nombre',
      '_sum[total]': 'total',
      '_count[*]': 'cantidad',
      'limit': '20',
      'count': 'true'
    })
  })
})

describe('withoutVariables()', () => {
  it('leaves out only the conditions that read a variable', () => {
    expect(withoutVariables({
      fields: 'id,total',
      where: {
        status: { _eq: 'OPEN' },
        customer: { _eq: '{{vars.customer.value}}' },
        _or: [{ total: { _gt: 100 } }, { total: { _lt: '{{vars.min.value}}' } }],
        _not: { kind: { _eq: '{{vars.kind.value}}' } }
      },
      search: '{{vars.term.value}}',
      limit: 50
    })).toEqual({
      fields: 'id,total',
      where: { status: { _eq: 'OPEN' }, _or: [{ total: { _gt: 100 } }] },
      limit: 50
    })
  })

  it('drops a filter left empty', () => {
    expect(withoutVariables({ where: { a: { _eq: '{{vars.a.value}}' } }, having: { _and: [{ n: { _gt: '{{vars.n.value}}' } }] } })).toEqual({})
  })
})
