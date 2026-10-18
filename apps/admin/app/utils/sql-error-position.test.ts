import { describe, expect, it } from 'vitest'
import { sqlErrorLocation } from './sql-error-position'

describe('sqlErrorLocation', () => {
  it('turns PostgreSQL\'s 1-based character position into line/column', () => {
    expect(sqlErrorLocation('SELEC 1', 1)).toEqual({ offset: 0, line: 1, column: 1 })
    const sql = 'SELECT 1;\nSELECT x FROM t;\n  SELEC 2'
    expect(sqlErrorLocation(sql, sql.indexOf('SELEC 2') + 1)).toEqual({ offset: sql.indexOf('SELEC 2'), line: 3, column: 3 })
    expect(sqlErrorLocation(sql, sql.indexOf('x FROM') + 1)).toMatchObject({ line: 2, column: 8 })
  })

  it('counts from where the sent text starts in the editor (a selection, trimmed whitespace)', () => {
    const editor = 'SELECT 1;\n\n  SELECT nope FROM t'
    const start = editor.indexOf('SELECT nope')
    expect(sqlErrorLocation(editor, 'SELECT '.length + 1, start)).toEqual({ offset: editor.indexOf('nope'), line: 3, column: 10 })
  })

  it('counts characters, not UTF-16 units: an emoji before the error is one character', () => {
    const sql = 'SELECT \'😀\' AS a, nope'
    // PostgreSQL's position: 'nope' is the 18th character (the emoji counts once).
    expect(sqlErrorLocation(sql, 18)).toMatchObject({ offset: sql.indexOf('nope'), line: 1, column: sql.indexOf('nope') + 1 })
  })

  it('a CRLF line break still starts a new line', () => {
    const sql = 'SELECT 1;\r\nSELEC 2'
    expect(sqlErrorLocation(sql, sql.indexOf('SELEC 2') + 1)).toMatchObject({ line: 2, column: 1 })
  })

  it('is null for a position outside the text', () => {
    expect(sqlErrorLocation('SELECT', 0)).toBeNull()
    expect(sqlErrorLocation('SELECT', 7)).toBeNull()
    expect(sqlErrorLocation('SELECT', 1.5)).toBeNull()
  })
})
