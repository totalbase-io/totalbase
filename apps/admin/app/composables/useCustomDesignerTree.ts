import type { WidgetName } from '@totalbase/tb-catalog'
import type { InjectionKey, Ref } from 'vue'
import type { DataViewField } from '~/types/dataview'
import type { CanvasArea } from '~/composables/useCustomCanvasContext'

/** The Structure tab's tree (CustomDesignerTree.vue, on the shared TreeView): an area and a widget. */
export interface TreeAreaNode { kind: 'area', key: string, label: string, area: CanvasArea, children: TreeWidgetNode[] }
export interface TreeWidgetNode { kind: 'widget', key: string, field: DataViewField, areas: TreeAreaNode[], flat: boolean }
export interface TreeFacts { hidden: string | false | null, formulas: string[], events: string[], errors: string[] }

/** What a "+" (CustomDesignerTreeAdd.vue) reads: which one is open, and where it places. */
export interface CustomDesignerTree {
  adding: Ref<string | null>
  placeIn: (area: TreeAreaNode, widget: WidgetName) => void
}

export const CUSTOM_DESIGNER_TREE_KEY: InjectionKey<CustomDesignerTree> = Symbol('custom-designer-tree')
