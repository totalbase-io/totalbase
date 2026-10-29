import { describe, expect, it } from 'vitest'
import { ulid, uuidV4, uuidV7 } from './random-uuid'

// The UUID and ULID fields' generators (DataViews.md §16.1).
describe('random ids', () => {
  it('makes a v4 UUID', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuidV4()).not.toBe(uuidV4())
  })

  it('makes a v7 UUID that starts with its time - later sorts after', () => {
    const at = Date.UTC(2026, 9, 28)
    const id = uuidV7(at)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at)
    expect(uuidV7(at + 1) > uuidV7(at)).toBe(true)
  })

  it('makes a ULID - 26 Crockford characters, its time first', () => {
    expect(ulid(0).slice(0, 10)).toBe('0000000000')
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ulid(1_000_001).slice(0, 10) > ulid(1_000_000).slice(0, 10)).toBe(true)
  })
})
