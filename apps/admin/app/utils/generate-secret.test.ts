import { describe, expect, it } from 'vitest'
import { generateSecret, secretLength } from './generate-secret'

describe('generateSecret', () => {
  it('base64url: URL-safe, no padding, as long as its size says', () => {
    for (const size of [16, 32, 64]) {
      const value = generateSecret('BASE64URL', size)
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(value).toHaveLength(secretLength('BASE64URL', size))
    }
  })

  it('hex: two characters per byte', () => {
    expect(generateSecret('HEX', 32)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('alphanumeric: letters and digits only, the size in characters', () => {
    const value = generateSecret('ALPHANUMERIC', 64)
    expect(value).toMatch(/^[A-Za-z0-9]{64}$/)
  })

  it('uuid: a version 4 UUID', () => {
    expect(generateSecret('UUID')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('never repeats a value', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateSecret('BASE64URL', 16)))
    expect(values.size).toBe(200)
  })
})
