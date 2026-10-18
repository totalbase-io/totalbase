import type { WidgetName } from '@totalbase/tb-catalog'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { DataViewField } from '~/types/dataview'
import { COLUMN_LAYOUTS } from '~/utils/widget-layout'

/**
 * The Design form's canvas state (CustomDesigner.vue), shared with every
 * area and item drawn on it (CustomCanvasArea.vue, CustomCanvasItem.vue) -
 * they sit at any depth inside the widgets WidgetRenderer draws, so props
 * can't reach them.
 */

/** An area: the page (`parent` null), or one slot of a widget. */
export interface CanvasArea {
  parent: string | null
  slot?: string
}
/** Where a drop lands: an area and the index in its order. */
export interface CanvasDropTarget extends CanvasArea {
  index: number
}
/** What is being dragged: a widget from the palette, or one already placed. */
export type CanvasDrag = { kind: 'new', widget: WidgetName } | { kind: 'move', id: string }

export interface CustomCanvasContext {
  /** Every placed widget of the page. */
  fields: ComputedRef<DataViewField[]>
  selectedId: Ref<string | null>
  /** False on a phone or a tablet: the canvas is static, edited through the inspector. */
  editable: ComputedRef<boolean>
  drag: Ref<CanvasDrag | null>
  dropTarget: Ref<CanvasDropTarget | null>
  /** Whether the dragged widget may land in `area` - never inside itself. */
  canDrop: (area: CanvasArea) => boolean
  drop: (target: CanvasDropTarget) => void
  /** A width or height change from a handle - saved when `save`. */
  resize: (fieldId: string, size: { gridW?: number, gridH?: number }, save: boolean) => void
  /** Enters a widget: its own-canvas slots (a Modal), or Focus on an inline container. */
  enter: (fieldId: string, mode: 'own' | 'focus') => void
  remove: (fieldId: string) => void
  /** A copy of the widget and what its slots hold, placed right after it. */
  duplicate: (fieldId: string) => void
  /** A new widget of the catalog at `target` (the Structure tree's "+"). */
  place: (widget: WidgetName, target: CanvasDropTarget) => void
  /** A placed widget to `target` - another area, or another place in its own. */
  move: (fieldId: string, target: CanvasDropTarget) => void
  /** One place earlier (-1) or later (1) in its area. */
  moveBy: (fieldId: string, delta: -1 | 1) => void
  /** The widget put inside a new Card or Box, where it was. */
  wrap: (fieldId: string, container: 'UCard' | 'TBox') => void
  /** Selects it and puts the cursor in its Name. */
  rename: (fieldId: string) => void
  /** Widgets hidden by a formula (or Visible off) drawn faded, dashed and labeled - off: as the App draws them when shown. */
  markHidden: Ref<boolean>
}

/** A widget's Visible rule: its formula, `false` when switched off, null when it always shows. */
export function hiddenRule(field: DataViewField): string | false | null {
  const config = field.config as { props?: Record<string, unknown>, bindings?: Record<string, { kind?: string, formula?: string }> }
  const binding = config.bindings?.visible
  if (binding?.kind === 'formula' && binding.formula) return binding.formula
  return config.props?.visible === false ? false : null
}

export const CUSTOM_CANVAS_CONTEXT_KEY: InjectionKey<CustomCanvasContext> = Symbol('custom-canvas-context')

/** Whether a drop target is `area`'s. */
export function isAreaTarget(target: CanvasDropTarget | null, area: CanvasArea): target is CanvasDropTarget {
  return target !== null && target.parent === area.parent && target.slot === area.slot
}

/**
 * A placed widget's "⋮" - the same on its canvas chrome and in the
 * inspector: its width in columns (where the canvas is editable),
 * Duplicate, Delete.
 */
export function widgetMenu(ctx: CustomCanvasContext, field: DataViewField): DropdownMenuItem[][] {
  const { t } = useNuxtApp().$i18n
  return [
    ...(ctx.editable.value
      ? [COLUMN_LAYOUTS.map(option => ({
          label: t('designer.useCustomCanvasContext.columns', option.columns),
          icon: option.icon,
          type: 'checkbox' as const,
          checked: (field.gridW || 12) === option.width,
          onSelect: () => ctx.resize(field.id, { gridW: option.width }, true)
        }))]
      : []),
    [
      { label: t('designer.useCustomCanvasContext.rename'), icon: 'i-lucide-pencil', kbds: ['f2'], onSelect: () => ctx.rename(field.id) },
      { label: t('common.duplicate'), icon: 'i-lucide-copy', kbds: ['meta', 'd'], onSelect: () => ctx.duplicate(field.id) },
      { label: t('designer.useCustomCanvasContext.moveUp'), icon: 'i-lucide-arrow-up', kbds: ['alt', 'arrowup'], onSelect: () => ctx.moveBy(field.id, -1) },
      { label: t('designer.useCustomCanvasContext.moveDown'), icon: 'i-lucide-arrow-down', kbds: ['alt', 'arrowdown'], onSelect: () => ctx.moveBy(field.id, 1) }
    ],
    // Wrapping: the widget moves into a new container - apart from what acts on it in place.
    [
      { label: t('designer.useCustomCanvasContext.wrapCard'), icon: 'i-lucide-square', onSelect: () => ctx.wrap(field.id, 'UCard') },
      { label: t('designer.useCustomCanvasContext.wrapBox'), icon: 'i-lucide-box', onSelect: () => ctx.wrap(field.id, 'TBox') }
    ],
    [{ label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, kbds: ['delete'], onSelect: () => ctx.remove(field.id) }]
  ]
}
