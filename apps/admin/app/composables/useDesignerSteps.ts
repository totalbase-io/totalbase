import type { Ref } from 'vue'
import { itemSlot, widgetDefinition, type WidgetName } from '@totalbase/tb-catalog'
import type { DataViewField, EditSize } from '~/types/dataview'
import { OVERLAY_CONTENT_WIDTH } from '~/utils/overlay-size'
import { areaWidgets } from '~/utils/widget-layout'
import type { CanvasArea, CanvasDropTarget } from '~/composables/useCustomCanvasContext'

/** One step into the canvas: a widget's own canvas (a Modal's slots), or one inline container alone (Focus). */
export interface CanvasStep { mode: 'own' | 'focus', id: string }

/**
 * What the Design canvas shows (CustomDesigner.vue, DataViews.md
 * §12.2): the page, or - one step at a time, with a breadcrumb back - a
 * widget's own canvas (a Modal's header, body and footer) or one inline
 * container alone (Focus).
 */
export function useDesignerSteps(options: {
  fields: Ref<DataViewField[]>
  fieldById: (id: string | null) => DataViewField | undefined
  widgetLabel: (field: DataViewField | undefined) => string
  slotLabel: (widget: string, slot: string, fallback: string) => string
  selectedId: Ref<string | null>
}) {
  const { t } = useI18n()
  const steps = ref<CanvasStep[]>([])
  const step = computed(() => steps.value.at(-1) ?? null)
  const stepField = computed(() => options.fieldById(step.value?.id ?? null))
  // A widget deleted while open: back to where it lived.
  watch(options.fields, () => {
    const index = steps.value.findIndex(s => !options.fieldById(s.id))
    if (index !== -1) steps.value = steps.value.slice(0, index)
  })
  const breadcrumb = computed(() => [
    { label: t('designer.customDesigner.breadcrumbPage'), onClick: steps.value.length ? () => (steps.value = []) : undefined, class: steps.value.length ? 'cursor-pointer' : undefined },
    ...steps.value.map((s, i) => ({
      label: s.mode === 'focus' ? t('designer.customDesigner.breadcrumbFocus', { widget: options.widgetLabel(options.fieldById(s.id)) }) : options.widgetLabel(options.fieldById(s.id)),
      onClick: i < steps.value.length - 1 ? () => (steps.value = steps.value.slice(0, i + 1)) : undefined,
      class: i < steps.value.length - 1 ? 'cursor-pointer' : undefined
    }))
  ])
  function enter(id: string, mode: 'own' | 'focus') {
    if (step.value?.id !== id) steps.value = [...steps.value, { mode, id }]
    options.selectedId.value = id
  }
  /** One step up the breadcrumb (Escape with nothing selected). */
  function back() {
    if (steps.value.length) steps.value = steps.value.slice(0, -1)
  }
  /** An own canvas's slots, drawn as the widget looks: a Modal centered, a Slideover to the right. */
  const ownSlots = computed(() => {
    const field = stepField.value
    if (step.value?.mode !== 'own' || !field?.widget) return []
    return Object.entries(widgetDefinition(field.widget as WidgetName).slots)
      .filter(([, slot]) => slot.canvas === 'own')
      .map(([slot, meta]) => ({ slot, label: options.slotLabel(field.widget!, slot, meta.label), inline: meta.inline === true }))
  })
  const ownFrameClass = computed(() => {
    const widget = stepField.value?.widget
    // A Modal's or a Slideover's Size: its canvas as wide as it opens.
    const size = (stepField.value?.config as { props?: { size?: EditSize } } | undefined)?.props?.size
    const width = size ? OVERLAY_CONTENT_WIDTH[size] : undefined
    if (widget === 'USlideover') return `ms-auto min-h-full ${width ?? 'max-w-md'}`
    if (widget === 'UPopover') return 'mx-auto max-w-sm'
    // A drawer is wide - the room it gives is why it's one.
    if (widget === 'TDrawer') return 'w-full'
    return `mx-auto ${width ?? 'max-w-2xl'}`
  })

  /** Where a palette click places a widget: at the end of the area in view. */
  function defaultTarget(): CanvasDropTarget {
    const field = stepField.value
    let area: CanvasArea = { parent: null }
    if (field?.widget) {
      const slots = widgetDefinition(field.widget as WidgetName).slots
      const names = Object.keys(slots).filter(slot => (slots[slot]!.canvas === 'own') === (step.value!.mode === 'own'))
      const slot = names.includes('body') ? 'body' : names[0]
      if (slot) {
        const items = (field.config as { props?: { items?: unknown[] } }).props?.items
        area = { parent: field.id, slot: slots[slot]!.perItem ? itemSlot(slot, items?.[0], 0) : slot }
      }
    }
    return { ...area, index: areaWidgets(options.fields.value, area.parent, area.slot).length }
  }

  return { steps, step, stepField, breadcrumb, enter, back, ownSlots, ownFrameClass, defaultTarget }
}
