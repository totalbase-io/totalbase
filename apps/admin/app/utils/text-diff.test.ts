import { describe, expect, it } from 'vitest'
import { diffLines, diffWords, tokenize } from './text-diff'

describe('text diff', () => {
  it('tokenizes into words, spaces and punctuation that join back to the text', () => {
    const text = 'numpad.test.17@demo.test, Ñandú 2'
    expect(tokenize(text).join('')).toBe(text)
    expect(tokenize('a.b')).toEqual(['a', '.', 'b'])
  })

  it('marks only what changed on each side', () => {
    const diff = diffWords('Numpad Test', 'Numpad Test Editado')!
    expect(diff.before).toEqual([{ text: 'Numpad Test', changed: false }])
    expect(diff.after).toEqual([{ text: 'Numpad Test', changed: false }, { text: ' Editado', changed: true }])
  })

  it('finds a changed word in the middle of an email', () => {
    const diff = diffWords('numpad.test.1@demo.test', 'numpad.nuevo.1@demo.test')!
    expect(diff.before.filter(s => s.changed).map(s => s.text)).toEqual(['test'])
    expect(diff.after.filter(s => s.changed).map(s => s.text)).toEqual(['nuevo'])
  })

  it('gives up on values too long to compare', () => {
    const long = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')
    expect(diffWords(long, `${long} x`)).toBeNull()
  })

  it('diffs multi-line values by line, with the kept lines as context', () => {
    expect(diffLines('{\n  "a": 1,\n  "b": 2\n}', '{\n  "a": 1,\n  "b": 3\n}')).toEqual([
      { sign: ' ', text: '{' },
      { sign: ' ', text: '  "a": 1,' },
      { sign: '-', text: '  "b": 2' },
      { sign: '+', text: '  "b": 3' },
      { sign: ' ', text: '}' }
    ])
  })
})
