import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
  it('formats binary units', () => {
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('takes a bigint column as its text, under 1 KB too', () => {
    expect(formatBytes('1')).toBe('1 bytes')
    expect(formatBytes('26521')).toBe('25.9 KB')
  })
})
