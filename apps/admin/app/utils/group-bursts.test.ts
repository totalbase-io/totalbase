import { describe, expect, it } from 'vitest'
import { groupBursts, groupBySignature } from './group-bursts'

const MIN = 60_000
const entry = (id: string, kind: string, minute: number) => ({ id, kind, at: minute * MIN })
const group = (items: Array<ReturnType<typeof entry>>) =>
  groupBursts(items, item => item.kind, item => item.at, 10 * MIN).map(burst => burst.map(item => item.id))

describe('groupBursts', () => {
  it('makes one burst of consecutive items alike, newest first', () => {
    expect(group([entry('c', 'setting', 12), entry('b', 'setting', 11), entry('a', 'setting', 10)])).toEqual([['c', 'b', 'a']])
  })

  it('never joins items alike that another kind sits between', () => {
    expect(group([entry('c', 'setting', 12), entry('b', 'role', 11), entry('a', 'setting', 10)])).toEqual([['c'], ['b'], ['a']])
  })

  it('splits items alike further apart than the gap', () => {
    expect(group([entry('b', 'setting', 30), entry('a', 'setting', 19)])).toEqual([['b'], ['a']])
    expect(group([entry('b', 'setting', 30), entry('a', 'setting', 20)])).toEqual([['b', 'a']])
  })

  it('chains: a burst lasts while its items keep coming, however long in all', () => {
    expect(group([entry('d', 'setting', 27), entry('c', 'setting', 18), entry('b', 'setting', 9), entry('a', 'setting', 0)])).toEqual([['d', 'c', 'b', 'a']])
  })

  it('answers nothing for nothing', () => {
    expect(group([])).toEqual([])
  })
})

describe('groupBySignature', () => {
  it('groups items alike wherever they are, in the order each first appears', () => {
    const items = [entry('a', 'x', 50), entry('b', 'y', 40), entry('c', 'x', 5), entry('d', 'z', 1)]
    expect(groupBySignature(items, item => item.kind).map(g => g.map(item => item.id))).toEqual([['a', 'c'], ['b'], ['d']])
  })
})
