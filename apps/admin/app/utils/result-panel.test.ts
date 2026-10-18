import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createResultTimer, resolveResult, resultSeconds, toneOf } from '~/utils/result-panel'

const WIDGET = { sound: true, resetAfter: 5 }

describe('resolveResult()', () => {
  it('takes a color, an icon, a title and a description', () => {
    expect(resolveResult({ color: 'success', icon: 'i-lucide-door-open', title: 'Welcome', description: 'Ana Pérez' }, WIDGET)).toEqual({
      color: 'success', icon: 'i-lucide-door-open', title: 'Welcome', description: 'Ana Pérez', tone: 'success', resetAfter: 5
    })
  })

  it('reads a text alone as its title, success by default with its icon', () => {
    expect(resolveResult('Done', WIDGET)).toMatchObject({ color: 'success', icon: 'i-lucide-circle-check', title: 'Done', description: '' })
  })

  it('gives each color its icon and tone unless show() names them', () => {
    expect(resolveResult({ color: 'error' }, WIDGET)).toMatchObject({ icon: 'i-lucide-circle-x', tone: 'error' })
    expect(resolveResult({ color: 'warning' }, WIDGET)).toMatchObject({ icon: 'i-lucide-triangle-alert', tone: 'error' })
    expect(resolveResult({ color: 'info' }, WIDGET)).toMatchObject({ tone: 'success' })
    expect(resolveResult({ color: 'error', sound: 'success' }, WIDGET).tone).toBe('success')
    expect(resolveResult({ color: 'error', sound: false }, WIDGET).tone).toBeNull()
  })

  it('falls back to neutral for a color the theme has not', () => {
    expect(resolveResult({ color: 'purple' }, WIDGET).color).toBe('neutral')
  })

  it('is silent when the widget is, unless show() names a tone', () => {
    expect(resolveResult({ color: 'error' }, { sound: false, resetAfter: 5 }).tone).toBeNull()
    expect(resolveResult({ color: 'error', sound: 'error' }, { sound: false, resetAfter: 5 }).tone).toBe('error')
  })

  it('takes resetAfter for one result, else the widget\'s', () => {
    expect(resolveResult({ resetAfter: 10 }, WIDGET).resetAfter).toBe(10)
    expect(resolveResult({ resetAfter: -1 }, WIDGET).resetAfter).toBe(5)
    expect(resolveResult({ resetAfter: 0 }, WIDGET).resetAfter).toBe(0)
  })
})

describe('resultSeconds()', () => {
  it('takes a number or a numeric text from 0 up', () => {
    expect(resultSeconds(3, 5)).toBe(3)
    expect(resultSeconds('2.5', 5)).toBe(2.5)
    expect(resultSeconds('x', 5)).toBe(5)
    expect(resultSeconds(null, 5)).toBe(5)
    expect(resultSeconds(-2, 5)).toBe(5)
  })
})

describe('toneOf()', () => {
  it('sounds error and warning as a refusal', () => {
    expect(toneOf('error')).toBe('error')
    expect(toneOf('warning')).toBe('error')
    expect(toneOf('primary')).toBe('success')
  })
})

describe('createResultTimer()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes back to waiting after its seconds', () => {
    const elapsed = vi.fn()
    const timer = createResultTimer(elapsed)
    timer.start(5)
    vi.advanceTimersByTime(4999)
    expect(elapsed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(elapsed).toHaveBeenCalledTimes(1)
    expect(timer.running).toBe(false)
  })

  it('gives a new result its whole time', () => {
    const elapsed = vi.fn()
    const timer = createResultTimer(elapsed)
    timer.start(5)
    vi.advanceTimersByTime(4000)
    timer.start(5)
    vi.advanceTimersByTime(4000)
    expect(elapsed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(elapsed).toHaveBeenCalledTimes(1)
  })

  it('never fires for 0 seconds, nor once cancelled', () => {
    const elapsed = vi.fn()
    const timer = createResultTimer(elapsed)
    timer.start(0)
    expect(timer.running).toBe(false)
    timer.start(2)
    timer.cancel()
    vi.advanceTimersByTime(10_000)
    expect(elapsed).not.toHaveBeenCalled()
  })
})
