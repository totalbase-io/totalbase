import { describe, expect, it } from 'vitest'
import { parseConditions } from '~/utils/filterConditions'

describe('parseConditions', () => {
  it('reads a stored filter\'s JSON numbers, booleans and lists into the builder', () => {
    expect(parseConditions('{"qty": {"_lte": 20}}')?.conditions[0]).toEqual({ field: 'qty', operator: '_lte', value: '20' })
    expect(parseConditions('{"active": {"_eq": true}}')?.conditions[0]?.value).toBe('true')
    expect(parseConditions('{"status": {"_in": ["A", "B"]}}')?.conditions[0]?.value).toBe('A,B')
    expect(parseConditions('{"qty": {"_between": [1, 5]}}')?.conditions[0]?.value).toEqual(['1', '5'])
  })

  it('leaves a list with a comma in an item to the JSON editor', () => {
    expect(parseConditions('{"status": {"_in": ["A", "B,C"]}}')).toBeNull()
  })
})
