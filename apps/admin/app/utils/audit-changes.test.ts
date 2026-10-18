import { describe, expect, it } from 'vitest'
import { updateDiffFromChanges } from './audit-changes'

describe('updateDiffFromChanges', () => {
  it('splits an UPDATE\'s changes into before and after', () => {
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { name: { old: 'a', new: 'b' }, price: { old: null, new: 2 } } }))
      .toEqual({ before: { name: 'a', price: null }, after: { name: 'b', price: 2 } })
  })

  it('has none for another action, no changes, or changes without old values', () => {
    expect(updateDiffFromChanges({ action: 'CREATE', changes: { name: { old: 'a', new: 'b' } } })).toBeNull()
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: null })).toBeNull()
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { name: { new: 'b' } } })).toBeNull()
  })
})
