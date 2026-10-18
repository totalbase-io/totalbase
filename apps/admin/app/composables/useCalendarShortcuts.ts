import type { CalendarViewMode } from '~/types/dataview'

/**
 * CALENDAR's own keyboard shortcuts - Prev/Next/Today/view-switch, same
 * "a real listener gated by an `active` ref" shape
 * `useRecordFormShortcuts.ts` already established for the record form's
 * own Save/Save & New/Clone. Plain, unmodified keys (no Ctrl/Cmd), same
 * convention most calendar apps (Google Calendar included) already use
 * for exactly these actions - deliberately NOT bound while focus is
 * inside a text input/textarea/select/contenteditable ANYWHERE on the
 * page (`isTypingTarget` below), so typing "t" into the Filter box or an
 * open event's own Title field never accidentally jumps the calendar to
 * today instead. Also skipped whenever a modifier key is held, so a
 * real OS/browser shortcut sharing the same letter (Cmd+D for
 * bookmarking, say) is never hijacked.
 */
export interface CalendarShortcutHandlers {
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  onViewChange: (view: CalendarViewMode) => void
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

export function useCalendarShortcuts(active: Ref<boolean>, handlers: CalendarShortcutHandlers) {
  function onKeydown(e: KeyboardEvent) {
    if (!active.value) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (isTypingTarget(document.activeElement)) return
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        handlers.onPrev()
        break
      case 'ArrowRight':
        e.preventDefault()
        handlers.onNext()
        break
      case 't':
      case 'T':
        handlers.onToday()
        break
      case 'd':
      case 'D':
        handlers.onViewChange('day')
        break
      case 'w':
      case 'W':
        handlers.onViewChange('week')
        break
      case 'm':
      case 'M':
        handlers.onViewChange('month')
        break
      case 'a':
      case 'A':
        handlers.onViewChange('agenda')
        break
    }
  }
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
