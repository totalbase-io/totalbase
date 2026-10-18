import type { DropdownMenuItem } from '@nuxt/ui'

/**
 * What can be done with one record, beyond opening it - each present only
 * when the DataView offers it (its record* features) and the viewer may
 * (Clone and Delete need write access). The caller wires each to the
 * record at hand: the one open in a form, or a grid row, or a card.
 */
export interface RecordMenuActions {
  /** Saves the record and starts a new one - while it is being edited, the only item (AGENTS.md section 25, record forms). */
  saveAndNew?: () => void
  clone?: () => void
  copy?: () => void
  print?: () => void
  activity?: () => void
  delete?: () => void
  /** The DataView's own actions on this record (Specification_DataViews.md §3.7) - a group of their own, before Delete. */
  custom?: DropdownMenuItem[]
}

/**
 * A record's "⋮" menu - one definition for a form's header, a grid's row
 * and a card, so they never drift: Clone | Copy, Print, Activity | its own actions | Delete.
 */
export function recordMenu(actions: RecordMenuActions, t?: (key: string) => string): DropdownMenuItem[][] {
  // The UI's language when the caller passes its `t` (Specification_Admin_UI.md §14); English otherwise.
  const label = (key: string, english: string) => t ? t(key) : english
  const groups: DropdownMenuItem[][] = [
    actions.saveAndNew ? [{ label: label('dataviews.record.saveAndNew', 'Save & New'), icon: 'i-lucide-save', kbds: ['meta', 'shift', 's'], onSelect: actions.saveAndNew }] : [],
    actions.clone ? [{ label: label('dataviews.recordMenu.clone', 'Clone'), icon: 'i-lucide-copy-plus', onSelect: actions.clone }] : [],
    [
      ...(actions.copy ? [{ label: label('dataviews.recordMenu.copy', 'Copy'), icon: 'i-lucide-clipboard-copy', onSelect: actions.copy }] : []),
      ...(actions.print ? [{ label: label('dataviews.recordMenu.print', 'Print'), icon: 'i-lucide-printer', onSelect: actions.print }] : []),
      ...(actions.activity ? [{ label: label('dataviews.recordMenu.activity', 'Activity'), icon: 'i-lucide-history', onSelect: actions.activity }] : [])
    ],
    actions.custom ?? [],
    actions.delete ? [{ label: label('common.delete', 'Delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: actions.delete }] : []
  ]
  return groups.filter(group => group.length > 0)
}
