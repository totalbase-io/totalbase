import { describe, expect, it } from 'vitest'
import { NOT_RECORDED, updateDiffFromChanges } from './audit-changes'

describe('updateDiffFromChanges', () => {
  it('splits an UPDATE\'s changes into before and after', () => {
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { name: { old: 'a', new: 'b' }, price: { old: null, new: 2 } } }))
      .toEqual({ before: { name: 'a', price: null }, after: { name: 'b', price: 2 } })
  })

  it('keeps an excluded column that changed, without values', () => {
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { name: { old: 'a', new: 'b' }, token_enc: { excluded: true } } }))
      .toEqual({ before: { name: 'a' }, after: { name: 'b', token_enc: NOT_RECORDED } })
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { token_enc: { excluded: true } } }))
      .toEqual({ before: {}, after: { token_enc: NOT_RECORDED } })
  })

  it('has none for another action, no changes, or changes without old values', () => {
    expect(updateDiffFromChanges({ action: 'CREATE', changes: { name: { old: 'a', new: 'b' } } })).toBeNull()
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: null })).toBeNull()
    expect(updateDiffFromChanges({ action: 'UPDATE', changes: { name: { new: 'b' } } })).toBeNull()
  })
})
