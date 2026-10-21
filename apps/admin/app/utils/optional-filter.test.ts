import { describe, expect, it } from 'vitest'
import { optionalFilterSql } from './optional-filter'

describe('optionalFilterSql', () => {
  it('writes the standard pattern for each variable type', () => {
    expect(optionalFilterSql({ name: 'status', type: 'SELECT' }, 'status')).toBe('($VAR.status IS NULL OR status::text = $VAR.status)')
    expect(optionalFilterSql({ name: 'tags', type: 'SELECT', multiple: true }, 'tag')).toBe('($VAR.tags IS NULL OR tag::text = ANY($VAR.tags))')
    expect(optionalFilterSql({ name: 'period', type: 'DATE_RANGE' }, 'created_at'))
      .toBe('($VAR.period.from IS NULL OR created_at >= $VAR.period.from) AND ($VAR.period.to IS NULL OR created_at < $VAR.period.to)')
    expect(optionalFilterSql({ name: 'q', type: 'TEXT' }, ' name ')).toBe('($VAR.q IS NULL OR name::text ILIKE \'%\' || $VAR.q || \'%\')')
    expect(optionalFilterSql({ name: 'min', type: 'NUMBER' }, 'o.total')).toBe('($VAR.min IS NULL OR o.total = $VAR.min)')
  })

  it('compares a Select or Text column as text - a uuid column has no = against the bound text', () => {
    expect(optionalFilterSql({ name: 'branch', type: 'SELECT' }, 'wo.branch')).toBe('($VAR.branch IS NULL OR wo.branch::text = $VAR.branch)')
    expect(optionalFilterSql({ name: 'q', type: 'TEXT' }, 'lower(c.name)')).toBe('($VAR.q IS NULL OR (lower(c.name))::text ILIKE \'%\' || $VAR.q || \'%\')')
  })
})
