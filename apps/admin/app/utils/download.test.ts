import { describe, expect, it } from 'vitest'
import { toCsv } from './download'

describe('toCsv', () => {
  it('quotes only what needs it, doubles quotes, and writes objects as JSON and nulls as empty', () => {
    expect(toCsv([['name', 'note'], ['Ana', 'a, b'], ['Bo "B"', null], ['x', { a: 1 }], ['line\nbreak', 3]]))
      .toBe('name,note\nAna,"a, b"\n"Bo ""B""",\nx,"{""a"":1}"\n"line\nbreak",3')
  })
})
