import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useBulkDelete } from './useBulkDelete'

// A list's Delete (Admin_UI.md §6.6): every target tried, a failure counted - not stopping the rest - and one toast.
describe('useBulkDelete', () => {
  const toasts: Array<{ title: string, description?: string, color: string }> = []
  beforeEach(() => {
    toasts.length = 0
    vi.stubGlobal('useToast', () => ({ add: (toast: typeof toasts[number]) => toasts.push(toast) }))
    vi.stubGlobal('useI18n', () => ({ t: (key: string, params: Record<string, unknown>) => `${key}:${JSON.stringify(params)}` }))
  })
  afterEach(() => vi.unstubAllGlobals())

  function setup(fail: string[] = []) {
    const removed: string[] = []
    const after = vi.fn()
    const drop = effectScope().run(() => useBulkDelete<string>({
      remove: async (id) => {
        if (fail.includes(id)) throw new Error('refused')
        removed.push(id)
      },
      after,
      deleted: n => `deleted ${n}`,
      failed: failures => `failed ${failures.join(',')}`
    }))!
    return { drop, removed, after }
  }

  it('opens on its targets and deletes them all, then runs after and says how many went', async () => {
    const { drop, removed, after } = setup()
    expect(drop.open.value).toBe(false)
    drop.start(['a', 'b'])
    expect(drop.open.value).toBe(true)
    await drop.confirm()
    expect(removed).toEqual(['a', 'b'])
    expect(after).toHaveBeenCalledWith(['a', 'b'])
    expect(drop.open.value).toBe(false)
    expect(toasts).toEqual([{ title: 'deleted 2', color: 'success' }])
  })

  it('keeps going past a failed one and names it in a partial toast', async () => {
    const { drop, removed } = setup(['b'])
    drop.start(['a', 'b', 'c'])
    await drop.confirm()
    expect(removed).toEqual(['a', 'c'])
    expect(toasts).toEqual([{ title: 'common.deletedPartial:{"done":2,"total":3}', description: 'failed b', color: 'warning' }])
  })

  it('takes the targets when it opens - a selection changing behind the modal does not move them', async () => {
    const { drop, removed } = setup()
    const selection = ['a']
    drop.start(selection)
    selection.push('b')
    await drop.confirm()
    expect(removed).toEqual(['a'])
  })
})
