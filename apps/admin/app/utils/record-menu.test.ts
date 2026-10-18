import { describe, expect, it } from 'vitest'
import { recordMenu } from './record-menu'

describe('recordMenu()', () => {
  it('groups what\'s offered - Clone | Copy, Print, Activity | Delete - and nothing else', () => {
    const noop = () => {}
    expect(recordMenu({ clone: noop, copy: noop, print: noop, activity: noop, delete: noop }).map(g => g.map(i => i.label)))
      .toEqual([['Clone'], ['Copy', 'Print', 'Activity'], ['Delete']])
    // Read-only: no Clone, no Delete.
    expect(recordMenu({ copy: noop, activity: noop }).map(g => g.map(i => i.label))).toEqual([['Copy', 'Activity']])
    expect(recordMenu({})).toEqual([])
  })
})
