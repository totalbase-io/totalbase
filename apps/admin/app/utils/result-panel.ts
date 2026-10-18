/**
 * The Result widget's logic (TResult, Specification_DataViews.md §9.11),
 * kept apart from the component so it is tested on its own: what a
 * `dataview.controls.<name>.show(...)` call means, which tone and vibration
 * go with it, and the timer that brings the panel back to waiting.
 */
import { WIDGET_COLORS } from '@totalbase/tb-catalog'
import type { ToneNote } from '~/utils/device-feedback'

export type ResultColor = (typeof WIDGET_COLORS)[number]
export type ResultTone = 'success' | 'error'

/** What a page's Code passes to `show()` - a text alone is its title. */
export interface ResultShowOptions {
  color?: string
  icon?: string
  title?: string
  description?: string
  /** `success` or `error` picks the tone; false, none; unset, the color's. */
  sound?: ResultTone | boolean
  /** Seconds before it goes back to waiting, for this result - unset, the widget's Reset after. */
  resetAfter?: number
}

/** A result as the panel draws it. */
export interface ResultState {
  color: ResultColor
  icon: string | undefined
  title: string
  description: string
  tone: ResultTone | null
  resetAfter: number
}

/** The icon a result shows when show() names none - by its color. */
const COLOR_ICONS: Partial<Record<ResultColor, string>> = {
  success: 'i-lucide-circle-check',
  error: 'i-lucide-circle-x',
  warning: 'i-lucide-triangle-alert',
  info: 'i-lucide-info'
}

/** A color's own tone: error and warning sound like a refusal, everything else like a pass. */
export function toneOf(color: ResultColor): ResultTone {
  return color === 'error' || color === 'warning' ? 'error' : 'success'
}

/** A whole number of seconds from 0 up, else `fallback`. */
export function resultSeconds(value: unknown, fallback: number): number {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : fallback
}

/**
 * `show()`'s argument as a result: an unknown color is `success` when there
 * is none and `neutral` otherwise; the tone follows the color unless `sound`
 * names one; the widget's `sound` off silences every result unless `sound`
 * names a tone.
 */
export function resolveResult(options: ResultShowOptions | string | null | undefined, widget: { sound: boolean, resetAfter: number }): ResultState {
  const given: ResultShowOptions = typeof options === 'string' ? { title: options } : (options ?? {})
  const color: ResultColor = given.color === undefined
    ? 'success'
    : (WIDGET_COLORS as readonly string[]).includes(given.color) ? given.color as ResultColor : 'neutral'
  const tone: ResultTone | null = given.sound === 'success' || given.sound === 'error'
    ? given.sound
    : given.sound === false || (given.sound === undefined && !widget.sound) ? null : toneOf(color)
  return {
    color,
    icon: typeof given.icon === 'string' && given.icon ? given.icon : COLOR_ICONS[color],
    title: given.title === undefined || given.title === null ? '' : String(given.title),
    description: given.description === undefined || given.description === null ? '' : String(given.description),
    tone,
    resetAfter: resultSeconds(given.resetAfter, widget.resetAfter)
  }
}

/** The notes of each tone - a rising pair for a pass, a low long pair for a refusal. */
export const RESULT_TONES: Readonly<Record<ResultTone, readonly ToneNote[]>> = {
  success: [{ frequency: 1318, duration: 0.09 }, { frequency: 1760, duration: 0.14 }],
  error: [{ frequency: 220, duration: 0.22 }, { frequency: 175, duration: 0.32 }]
}
/** How each tone vibrates (ms on, off, on). */
export const RESULT_VIBRATIONS: Readonly<Record<ResultTone, number[]>> = {
  success: [80],
  error: [200, 100, 200]
}

/**
 * The timer back to waiting: each `start` replaces the previous one - a new
 * result gets its whole time -, 0 seconds never fires, `cancel` stops it.
 */
export function createResultTimer(onElapsed: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    start(seconds: number) {
      cancel()
      if (seconds > 0) {
        timer = setTimeout(() => {
          timer = null
          onElapsed()
        }, seconds * 1000)
      }
    },
    cancel,
    get running() {
      return timer !== null
    }
  }
}
