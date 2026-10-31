import type { Ref } from 'vue'
import { widgetDefinition, type WidgetName } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { areaWidgets, childWidgets } from '~/utils/widget-layout'
import type { CanvasStep } from '~/composables/useDesignerSteps'

/**
 * The Design canvas toolbar's 1-4 columns (CustomDesigner.vue): every widget
 * in view to one width, the flow wrapping them into rows in their order -
 * and its Undo, until the canvas shows another area.
 */
export function useDesignerColumns(options: {
  fields: Ref<DataViewField[]>
  fieldById: (id: string | null) => DataViewField | undefined
  slotOf: (field: DataViewField) => string | undefined
  /** The area in view - its steps reset the Undo. */
  steps: Ref<CanvasStep[]>
  stepField: Ref<DataViewField | undefined>
  saveField: (id: string, patch: Record<string, unknown>) => Promise<boolean>
  reload: () => Promise<void>
}) {
  /**
   * The widgets the toolbar's columns lay out: the page's, or - with a widget
   * open - what each of its slots holds. A lone container is gone through: a
   * record page's fields sit in one Form, and they - not the Form - are what
   * 1-4 columns arranges. A form field's input isn't one: its width is the
   * field's.
   */
  const layoutWidgets = computed(() => {
    const field = options.stepField.value
    let widgets = field?.widget ? slotWidgets(field, true) : areaWidgets(options.fields.value, null, undefined)
    while (widgets.length === 1) {
      const inner = slotWidgets(widgets[0]!, false)
      if (inner.length === 0) break
      widgets = inner
    }
    // A fitting widget (Fit content) keeps its own width: the columns lay out the ones that fill.
    return widgets.filter(f => f.gridW !== 0)
  })
  /** What `field`'s slots hold, in order - its own-canvas slots' (a Modal's) only when it's the one open. */
  function slotWidgets(field: DataViewField, ownCanvas: boolean): DataViewField[] {
    if (!field.widget) return []
    const slots = widgetDefinition(field.widget as WidgetName).slots
    return childWidgets(options.fields.value, field.id)
      .filter((f) => {
        const slot = slots[options.slotOf(f)?.split(':')[0] ?? '']
        return slot?.holds !== 'input' && (ownCanvas || slot?.canvas !== 'own')
      })
      .sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX)
  }
  /** The width every laid-out widget shares, if they share one - its button shows as the current layout. */
  const currentWidth = computed(() => {
    const widths = new Set(layoutWidgets.value.map(f => f.gridW))
    return widths.size === 1 ? [...widths][0]! : null
  })
  /** The widths before the last columns layout - its Undo, until the canvas shows another area. */
  const columnsUndo = ref<{ id: string, gridW: number }[] | null>(null)
  watch(options.steps, () => (columnsUndo.value = null))
  async function setWidths(widths: Map<string, number>) {
    const changed = [...widths].filter(([id, width]) => options.fieldById(id) && options.fieldById(id)!.gridW !== width)
    if (changed.length === 0) return
    options.fields.value = options.fields.value.map(f => (widths.has(f.id) ? { ...f, gridW: widths.get(f.id)! } : f))
    const saved = await Promise.all(changed.map(([id, width]) => options.saveField(id, { gridW: width })))
    if (saved.includes(false)) await options.reload()
  }
  /** Every widget in view to `width` columns - the flow wraps them into rows, in their order. */
  async function applyColumns(width: number) {
    const widgets = layoutWidgets.value
    columnsUndo.value = widgets.map(f => ({ id: f.id, gridW: f.gridW }))
    await setWidths(new Map(widgets.map(f => [f.id, width])))
  }
  async function undoColumns() {
    const snapshot = columnsUndo.value
    columnsUndo.value = null
    if (snapshot) await setWidths(new Map(snapshot.map(s => [s.id, s.gridW])))
  }

  return { layoutWidgets, currentWidth, columnsUndo, applyColumns, undoColumns }
}
