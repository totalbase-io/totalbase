import { describe, expect, it } from 'vitest'
import { declaresFunction, findDeclaration } from './declares-function'

describe('declaresFunction()', () => {
  it('finds a function declaration, async or not', () => {
    expect(declaresFunction('function onNoteChange(dataview, value) {}', 'onNoteChange')).toBe(true)
    expect(declaresFunction('async function onLoad (dataview) {}', 'onLoad')).toBe(true)
  })

  it('finds a const/let/var binding', () => {
    expect(declaresFunction('const onSave = (dataview) => {}', 'onSave')).toBe(true)
    expect(declaresFunction('let onSave=function () {}', 'onSave')).toBe(true)
  })

  it('does not match a call, a longer name, or a missing name', () => {
    expect(declaresFunction('onNoteChange(dataview)', 'onNoteChange')).toBe(false)
    expect(declaresFunction('function onNoteChanged() {}', 'onNoteChange')).toBe(false)
    expect(declaresFunction('', 'onLoad')).toBe(false)
  })

  it('treats regex metacharacters in the name literally', () => {
    expect(declaresFunction('function $a() {}', '$a')).toBe(true)
    expect(declaresFunction('function xa() {}', '.a')).toBe(false)
  })
})

describe('findDeclaration()', () => {
  it('returns the matched declaration text, whichever style it uses', () => {
    expect(findDeclaration('// x\nfunction onLoad (dataview) {}', 'onLoad')).toBe('function onLoad (')
    expect(findDeclaration('const onLoad = () => {}', 'onLoad')).toBe('const onLoad =')
    expect(findDeclaration('onLoad()', 'onLoad')).toBeNull()
  })
})
