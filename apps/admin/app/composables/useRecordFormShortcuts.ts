/**
 * Save/Save & New/Clone keyboard shortcuts for a grid's record form
 * (DataViewRecordPanel.vue, in every presentation), cross-platform: Ctrl/Cmd+S (Save), Ctrl/Cmd+Shift+S (Save &
 * New - no strong existing convention for this one specifically, chosen
 * as a variant of Save's own), Ctrl/Cmd+D (Clone - the real "duplicate"
 * convention: Figma, Google Sheets, Finder).
 *
 * Deliberately no shortcut for Delete or "leave without saving" - a
 * destructive action shouldn't be one stray keystroke away while typing
 * in a field, and Esc is already claimed by every popover/select/date-
 * picker widget INSIDE the form itself to close itself first; binding
 * it here too risks navigating away instead of just closing whatever
 * was actually open.
 *
 * `active` gates whether the listener does anything at all - the panel
 * stays mounted with `open` toggling rather than being destroyed/recreated
 * per open/close, so without this a Ctrl+S while the drawer/modal/sidebar
 * is CLOSED would still save.
 */
export interface RecordFormShortcutHandlers {
  onSave: () => void
  onSaveAndNew?: () => void
  onClone?: () => void
}

/** "⌘S"/"⌘⇧S" on a Mac, "Ctrl+S"/"Ctrl+Shift+S" elsewhere - the record form's frame (DataViewRecordPanel.vue)'s own button tooltips, not a hard platform check for anything functional (the listener above binds BOTH metaKey and ctrlKey regardless of what this says). */
export function shortcutLabel(key: string, shift = false): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
  return isMac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/**
 * Live gates for Save & New/Clone - the DataView's own `features.
 * recordSaveAndNew`/`recordClone` (types/dataview.ts's TABLE_FEATURES,
 * `group: 'form'`). Refs, not plain booleans, read inside the listener
 * so they always reflect the current state. `undefined` (a caller that doesn't pass one) behaves as always
 * enabled, unchanged from before these gates existed.
 */
export interface RecordFormShortcutGates {
  /** `undefined`/a `Ref` currently holding `undefined` both mean "enabled" - only an explicit `false` disables (see the `=== false` check below), same as a `Record<string, boolean>` feature lookup that hasn't resolved yet or predates the key. */
  saveAndNew?: Ref<boolean | undefined>
  clone?: Ref<boolean | undefined>
}

export function useRecordFormShortcuts(active: Ref<boolean>, handlers: RecordFormShortcutHandlers, gates?: RecordFormShortcutGates) {
  function onKeydown(e: KeyboardEvent) {
    if (!active.value) return
    if (!(e.metaKey || e.ctrlKey)) return
    const key = e.key.toLowerCase()
    if (key === 's' && e.shiftKey) {
      if (!handlers.onSaveAndNew || gates?.saveAndNew?.value === false) return
      e.preventDefault()
      handlers.onSaveAndNew()
    } else if (key === 's') {
      e.preventDefault()
      handlers.onSave()
    } else if (key === 'd') {
      if (!handlers.onClone || gates?.clone?.value === false) return
      e.preventDefault() // otherwise the browser's own "bookmark this page" dialog opens
      handlers.onClone()
    }
  }
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
