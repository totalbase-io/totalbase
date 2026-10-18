import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useDebouncedRef } from './useDebouncedRef'

describe('useDebouncedRef', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts at the source value and follows it only once the source has been still for the delay', async () => {
    const source = ref('a')
    const scope = effectScope()
    const debounced = scope.run(() => useDebouncedRef(source, 300))!
    expect(debounced.value).toBe('a')

    source.value = 'ab'
    await nextTick()
    vi.advanceTimersByTime(200)
    source.value = 'abc'
    await nextTick()
    vi.advanceTimersByTime(200)
    // 400 ms after the first keystroke, 200 ms after the last: still waiting.
    expect(debounced.value).toBe('a')
    vi.advanceTimersByTime(100)
    expect(debounced.value).toBe('abc')
    scope.stop()
  })

  it('takes a getter, and drops a pending update with its scope', async () => {
    const source = ref('  x ')
    const scope = effectScope()
    const debounced = scope.run(() => useDebouncedRef(() => source.value.trim()))!
    expect(debounced.value).toBe('x')
    source.value = 'y'
    await nextTick()
    scope.stop()
    vi.advanceTimersByTime(1000)
    expect(debounced.value).toBe('x')
  })
})
