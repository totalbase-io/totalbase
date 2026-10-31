<script setup lang="ts">
/**
 * The Design form of a CUSTOM DataView (DataViews.md §12):
 * Design · Variables · Code.
 *
 * - Design: the palette is the widget catalog (every widget, by group); the
 *   canvas is one free 12-column area at a time - the page itself, or one
 *   slot of a widget, opened like a container today (breadcrumb to go back
 *   up); the inspector is the generic WidgetInspector over the widget's
 *   config, plus its name (`dataview.controls.<name>`).
 * - Variables: CustomVariablesPanel over `view_config.variables`.
 * - Code: the page's Code; "Create handler" scaffolds into it.
 *
 * The tabs themselves are the host page's (its header, `v-model:view`).
 *
 * Every change is saved as it happens (a field PATCH, the variables with
 * the DataView, the code) and validated by the server with the same
 * catalogs; the page header shows the combined status.
 */
import {
  newWidgetControlConfig,
  PAGE_FOOTER_SLOT,
  PAGE_FOOTER_WIDGETS,
  PAGE_HEADER_SLOT,
  PAGE_HEADER_WIDGETS,
  WIDGET_CATALOG,
  widgetDefinition,
  type ColumnPresentation,
  type VariableDefinition,
  type VariableKind,
  type WidgetControlConfig,
  type WidgetItem,
  type WidgetName,
  VARIABLE_CATALOG
} from '@totalbase/tb-catalog'
import type { SplitterItem } from '@nuxt/ui'
import {
  EDIT_PRESENTATION_META,
  FORM_LIKE_DATAVIEW_TYPES,
  FORM_VIEW_MODE_META,
  MASTER_DETAIL_OPEN_WITH_META,
  dataviewMetaKey,
  resolveEditPresentation,
  resolveEditSide,
  storedEditSize,
  resolveFitToScreen,
  resolveFormViewMode,
  resolveMasterDetailOpenWith,
  storedPageContentAlign,
  storedPageContentWidth,
  type DataView,
  type DataViewField,
  type DesignerView,
  type EditPresentation,
  type EditSide,
  type EditSize,
  type FormViewMode,
  type MasterDetailOpenWith,
  type PageContentAlign,
  type PageContentWidth
} from '~/types/dataview'
import type { AutosaveStatus } from '~/composables/useAutosave'
import { AdminApiError } from '~/utils/admin-api-error'
import { useCatalogText } from '~/utils/catalog-text'
import { CUSTOM_CANVAS_CONTEXT_KEY, widgetMenu, type CanvasArea, type CanvasDrag, type CanvasDropTarget, type CustomCanvasContext } from '~/composables/useCustomCanvasContext'
import { designRuntime, queryFields, WIDGET_RUNTIME_KEY } from '~/composables/useWidgetRuntime'
import { declaredFunctions, handlerName, handlerScaffold, handlerWithBody, rowsChangedHandler, withoutUntouchedHandler } from '~/utils/custom-code'
import SnippetModal from '~/components/SnippetModal.vue'
import type { SnippetContext } from '~/components/SnippetParamsForm.vue'
import { areaWidgets, childWidgets, fieldById as indexedFieldById } from '~/utils/widget-layout'
import type { RelationDetail } from '~/types/schema'
import CodeEditor from '~/components/CodeEditor.vue'
import CodeReferenceSlideover from '~/components/CodeReferenceSlideover.vue'
import CustomCanvasArea from '~/components/CustomCanvasArea.vue'
import CustomCanvasItem from '~/components/CustomCanvasItem.vue'
import CustomDesignerAddFieldsModal, { type AddFieldCandidate } from '~/components/CustomDesignerAddFieldsModal.vue'
import CustomDesignerCanvasToolbar from '~/components/CustomDesignerCanvasToolbar.vue'
import CustomDesignerCodeToolbar from '~/components/CustomDesignerCodeToolbar.vue'
import CustomDesignerFieldSetupModal, { type FieldSetupSpec } from '~/components/CustomDesignerFieldSetupModal.vue'
import CustomDesignerPalette from '~/components/CustomDesignerPalette.vue'
import CustomDesignerTree from '~/components/CustomDesignerTree.vue'
import CustomVariablesPanel from '~/components/CustomVariablesPanel.vue'
import WidgetInspector from '~/components/WidgetInspector.vue'
import { withRelatedPresentation } from '~/utils/widget-table'

const props = defineProps<{
  dataview: DataView
  fields: DataViewField[]
}>()
/** The tab showing - its tabs are the host page's. */
const view = defineModel<DesignerView>('view', { default: 'design' })
/**
 * The tabs opened so far. The Variables panel and the Code tab's Monaco
 * mount on their first visit, not with the Design tab (most sessions
 * never open Code: Monaco's ~1.4 MB of workers and the editor itself
 * stayed out of a design session's way until then) - and stay mounted
 * after, keeping their state (the cursor, the selected variable).
 */
const visitedViews = reactive(new Set<DesignerView>())
watch(view, v => visitedViews.add(v), { immediate: true })
/** A form field's column's presentation saved in the table (its inspector) - the host reads the DataView again. */
const emit = defineEmits<{ presentationSaved: [], openSaved: [], draftChanged: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const cat = useDesignerCatalogText()
const notifyError = useErrorToast()
/** Every write, tracked for the header's status; `flush()` waits for them. */
const writes = useAutosave(async () => {})

function failed(title: string, error: unknown) {
  // A widget the server no longer has: the draft was rebuilt elsewhere (an agent by MCP, another tab) - the host
  // offers to reload it (DataViews.md §12.6); the technical error would say nothing to the person.
  if (error instanceof AdminApiError && error.code === 'DATAVIEW_FIELD_NOT_FOUND') {
    emit('draftChanged')
    return
  }
  notifyError(error, title)
}

// --- Widgets -------------------------------------------------------------------

const localFields = ref<DataViewField[]>(props.fields.filter(f => f.kind === 'WIDGET'))
const allWidgets = computed(() => localFields.value)
/** A Resource variable, by name - what a Table on the canvas shows the columns of. */
function resourceVariable(name: string) {
  const definition = variables.value.find(v => v.name === name)
  return definition?.kind === 'RESOURCE' ? definition : undefined
}
function resourceColumns(name: string): Record<string, string> | undefined {
  const definition = resourceVariable(name)
  return definition ? props.dataview.variableResources?.[definition.resource]?.columns : undefined
}
/** Its query's fields in order - all of its columns when it names none. */
function resourceFields(name: string): string[] {
  return queryFields(resourceVariable(name)?.query?.fields, resourceColumns(name))
}
/** What its resource's columns set - what a Table's columns inherit (the draft's, live). */
function resourcePresentation(name: string): Record<string, ColumnPresentation> | undefined {
  const definition = resourceVariable(name)
  if (!definition) return undefined
  return withRelatedPresentation(props.dataview.columnPresentation?.[definition.resource], resourceFields(name), props.dataview.variableResources?.[definition.resource]?.relations, props.dataview.columnPresentation)
}
/** The record: the page's source table (useDesignerRecord, DataViews.md §8.5) - its columns and foreign keys, for a field bound to a column, and what each column's presentation sets. */
const { recordTable, recordTableName, recordColumns, recordRelations, recordJunctions, recordPresentation, columnTitle, inputForColumn } = useDesignerRecord(() => props.dataview)
/** A record column's presentation, in Database - its table's page opens it. */
const router = useRouter()
function presentationLink(column: string): string | undefined {
  // Resolved (the app's base included): it opens in a new tab.
  return props.dataview.sourceResource ? router.resolve({ path: `/resources/${props.dataview.sourceResource}`, query: { presentation: column } }).href : undefined
}
provide(WIDGET_RUNTIME_KEY, designRuntime(allWidgets, CustomCanvasArea, { resourceColumns, resourceFields, resourcePresentation, recordPresentation }))

/** The selected widget's id - its inspector shows; the host page keeps it in the URL (`?field=<id>`). */
const selectedId = defineModel<string | null>('selectedField', { default: null })
// A link to a widget no longer on the page selects nothing.
if (selectedId.value && !localFields.value.some(f => f.id === selectedId.value)) selectedId.value = null
const selected = computed(() => localFields.value.find(f => f.id === selectedId.value) ?? null)
// A widget selected out of view - placed at the end of a long page, a copy - is scrolled to.
watch(selectedId, async (id) => {
  if (!id) return
  await nextTick()
  document.querySelector(`[data-canvas-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

function fieldById(id: string | null) {
  return indexedFieldById(localFields.value, id)
}
function slotOf(field: DataViewField): string | undefined {
  return (field.config as { slot?: string }).slot
}
function widgetLabel(field: DataViewField | undefined): string {
  if (!field?.widget) return ''
  return field.label || cat.widgetLabel(field.widget, widgetDefinition(field.widget as WidgetName).label)
}

/** The page's widgets again, after a write failed half way - the canvas never shows what isn't saved. */
async function reload() {
  try {
    const { data } = await api.get<DataViewField[]>(`/dataviews/${props.dataview.id}/fields`)
    localFields.value = data.filter(f => f.kind === 'WIDGET')
  } catch (error) {
    failed(t('designer.customDesigner.reloadError'), error)
  }
}

async function saveField(id: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const { data } = await writes.track(api.patch<DataViewField>(`/dataviews/${props.dataview.id}/fields/${id}`, { data: patch }))
    localFields.value = localFields.value.map(f => (f.id === id ? data : f))
    return true
  } catch (error) {
    failed(t('designer.customDesigner.saveWidgetError'), error)
    return false
  }
}

/** Every widget inside `id`'s slots, at any depth, and `id` itself - PostgreSQL deletes them with it (ON DELETE CASCADE). */
function descendants(id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of localFields.value) {
      if (f.parent && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
    }
  }
  return out
}
async function remove(id: string) {
  const inside = descendants(id).size - 1
  if (inside > 0 && !window.confirm(t('designer.customDesigner.deleteConfirm', { n: inside }, inside))) return
  try {
    await writes.track(api.del(`/dataviews/${props.dataview.id}/fields/${id}`))
    const gone = descendants(id)
    const removed = localFields.value.filter(f => gone.has(f.id))
    localFields.value = localFields.value.filter(f => !gone.has(f.id))
    dropDetailHandlers(removed)
    if (selectedId.value && gone.has(selectedId.value)) selectedId.value = null
  } catch (error) {
    failed(t('designer.customDesigner.deleteError'), error)
  }
}

// --- Canvas (DataViews.md §12.2, useDesignerSteps) -----------------------------------------

const { steps, step, stepField, breadcrumb, enter, ownSlots, ownFrameClass, defaultTarget } = useDesignerSteps({
  fields: localFields,
  fieldById,
  widgetLabel,
  slotLabel: (widget, slot, fallback) => cat.slotLabel(widget, slot, fallback),
  selectedId
})

/** Orders an area as `ids` says - only the widgets whose order changed are saved. */
async function arrange(ids: string[]) {
  const changed = ids.flatMap((id, order) => (fieldById(id)?.gridY === order ? [] : [{ id, order }]))
  if (changed.length === 0) return
  const orders = new Map(changed.map(c => [c.id, c.order]))
  localFields.value = localFields.value.map(f => (orders.has(f.id) ? { ...f, gridY: orders.get(f.id)! } : f))
  const saved = await Promise.all(changed.map(c => saveField(c.id, { gridY: c.order })))
  if (saved.includes(false)) await reload()
}
/** `field`, already in `target`'s area, moved to `target.index`. */
function insertAt(field: DataViewField, target: CanvasDropTarget) {
  const ids = areaWidgets(localFields.value, target.parent, target.slot).filter(f => f.id !== field.id).map(f => f.id)
  ids.splice(target.index, 0, field.id)
  return arrange(ids)
}

/**
 * A widget's starting props: the catalog's, without its sample label when it's a form field's
 * input - the field shows the label; "Switch" or "File upload" beside the input would repeat it.
 */
function startingProps(name: WidgetName, parentId: string | null | undefined): Record<string, unknown> {
  const { label, ...rest } = newWidgetControlConfig(name).props
  const inField = parentId ? localFields.value.find(f => f.id === parentId)?.widget === 'UFormField' : false
  return inField || label === undefined ? rest : { ...rest, label }
}

async function place(name: WidgetName, target: CanvasDropTarget = defaultTarget()) {
  if (widgetDefinition(name).setup === 'input') return openFieldSetup(target)
  const config = { ...newWidgetControlConfig(name), props: startingProps(name, target.parent) }
  const body = {
    widget: name,
    parent: target.parent,
    config: { props: config.props, bindings: config.bindings, emits: config.emits, ...(target.slot ? { slot: target.slot } : {}) }
  }
  try {
    const { data } = await writes.track(api.post<DataViewField>(`/dataviews/${props.dataview.id}/widgets`, { data: body }))
    localFields.value = [...localFields.value, data]
    selectedId.value = data.id
    await insertAt(data, target)
  } catch (error) {
    failed(t('designer.customDesigner.addWidgetError', { widget: cat.widgetLabel(name, WIDGET_CATALOG[name].label) }), error)
  }
}

/**
 * An embedded DataView linked to the page's record (Linked by set, on a page
 * with a record): its rows changing rereads the record, keeping edits -
 * totals a trigger recomputed show up. Written as code the author can read
 * and change, not done behind the scenes.
 */
function refreshRecordOnRowsChanged(field: DataViewField) {
  const name = handlerName(widgetLabel(field), 'rowsChanged', codeFunctions.value)
  code.value = `${code.value.trimEnd()}\n\n${rowsChangedHandler(name)}`
  const config = configOf(field)
  updateConfig(field.id, { ...config, emits: { ...config.emits, rowsChanged: name } })
}

/**
 * A deleted embed takes the rowsChanged handler it wrote - while it's as
 * written, and nothing else (another widget, a variable, the record) calls it.
 */
function dropDetailHandlers(removed: DataViewField[]) {
  const stillCalled = JSON.stringify([localFields.value.map(f => configOf(f).emits), variables.value, recordConfig.value])
  for (const field of removed) {
    const name = field.widget === 'TDataView' ? configOf(field).emits?.rowsChanged : undefined
    if (!name || stillCalled.includes(`"${name}"`)) continue
    code.value = withoutUntouchedHandler(code.value, name, rowsChangedHandler(name))
  }
}

async function move(id: string, target: CanvasDropTarget) {
  const field = fieldById(id)
  if (!field) return
  const sameArea = field.parent === target.parent && slotOf(field) === target.slot
  let index = target.index
  if (sameArea) {
    // Its own place counts until it leaves it.
    const from = areaWidgets(localFields.value, target.parent, target.slot).findIndex(f => f.id === id)
    if (from < index) index--
  }
  if (!sameArea) {
    const { slot: _slot, ...rest } = field.config as Record<string, unknown>
    const config = { ...rest, ...(target.slot ? { slot: target.slot } : {}) }
    localFields.value = localFields.value.map(f => (f.id === id ? { ...f, parent: target.parent, config } : f))
    if (!await saveField(id, { parent: target.parent, config })) return reload()
  }
  await insertAt(fieldById(id)!, { ...target, index })
}

// --- How the form opens (DataViews.md §6.3, §6.7): the toolbar's popover, the same controls as
// Settings › Form (DataViewOpenSettings.vue), each change written to the DataView at once. ---
const openSettingsOpen = ref(false)
const editPresentation = ref<EditPresentation>(resolveEditPresentation(props.dataview.viewConfig))
const editSize = ref<EditSize | null>(storedEditSize(props.dataview.viewConfig))
const editSide = ref<EditSide>(resolveEditSide(props.dataview.viewConfig))
const formViewMode = ref<FormViewMode>(resolveFormViewMode(props.dataview.viewConfig))
const masterDetailOpenWith = ref<MasterDetailOpenWith>(resolveMasterDetailOpenWith(props.dataview.viewConfig))
const newRecordLabel = ref(typeof props.dataview.viewConfig.new_record_label === 'string' ? props.dataview.viewConfig.new_record_label : '')
const pageContentWidth = ref<PageContentWidth | null>(storedPageContentWidth(props.dataview.viewConfig))
const pageContentAlign = ref<PageContentAlign | null>(storedPageContentAlign(props.dataview.viewConfig))
const fitToScreen = ref(resolveFitToScreen(props.dataview.viewConfig))
const isCustomPage = computed(() => props.dataview.viewType === 'CUSTOM')
const openSettingsBody = computed(() => ({
  ...(isCustomPage.value
    ? {}
    : FORM_LIKE_DATAVIEW_TYPES.includes(props.dataview.viewType)
      ? { ...(props.dataview.viewType === 'FORM' && { form_view_mode: formViewMode.value }), ...(props.dataview.viewType === 'MASTER_DETAIL' && { open_with: masterDetailOpenWith.value, new_record_label: newRecordLabel.value.trim() || null }) }
      : { edit_presentation: editPresentation.value, edit_size: editSize.value, edit_side: editSide.value }),
  page_content_width: pageContentWidth.value,
  page_content_align: pageContentAlign.value,
  ...(isCustomPage.value ? {} : { fit_to_screen: fitToScreen.value })
}))
let openSettingsSaved = JSON.stringify(openSettingsBody.value)
watch(openSettingsBody, async (body) => {
  const sent = JSON.stringify(body)
  if (sent === openSettingsSaved) return
  openSettingsSaved = sent
  try {
    await writes.track(api.patch(`/dataviews/${props.dataview.id}`, { data: { viewConfig: body } }))
    emit('openSaved')
  } catch (error) {
    failed(t('designer.customDesigner.openSaveError'), error)
  }
})
const dataviewMetaText = useCatalogText()
/** The toolbar button's label: how the form opens today. */
const openSettingsLabel = computed(() => {
  const type = props.dataview.viewType
  if (type === 'CUSTOM') return t('designer.customDesigner.pageOptions')
  if (type === 'FORM') return dataviewMetaText(dataviewMetaKey('formViewModes', formViewMode.value, 'label'), FORM_VIEW_MODE_META[formViewMode.value].label)
  if (type === 'MASTER_DETAIL') return dataviewMetaText(dataviewMetaKey('openWith', masterDetailOpenWith.value, 'label'), MASTER_DETAIL_OPEN_WITH_META[masterDetailOpenWith.value].label)
  return dataviewMetaText(dataviewMetaKey('editPresentations', editPresentation.value, 'label'), EDIT_PRESENTATION_META[editPresentation.value].label)
})

// --- Columns (the canvas toolbar, useDesignerColumns) and Duplicate (a widget's menu) --------------

const { layoutWidgets, currentWidth, columnsUndo, applyColumns, undoColumns } = useDesignerColumns({ fields: localFields, fieldById, slotOf, steps, stepField, saveField, reload })

/**
 * A copy of `id` and everything its slots hold, at any depth, right after
 * it - for a form field's input, of its field. The copy has no name - a name is how code reaches one widget - and
 * shares the original's handlers. A copy that fails half way is deleted
 * whole (its slots cascade).
 */
async function duplicate(id: string) {
  // A form field's input: the field is what gets copied.
  const source = inputFieldOf(fieldById(id)) ?? fieldById(id)
  if (!source?.widget) return
  const created: DataViewField[] = []
  async function copy(field: DataViewField, parent: string | null, order: number | null): Promise<DataViewField> {
    const { data } = await writes.track(api.post<DataViewField>(`/dataviews/${props.dataview.id}/widgets`, { data: { widget: field.widget, parent, config: field.config } }))
    const sizable = widgetDefinition(field.widget as WidgetName).sizable
    const { data: sized } = await writes.track(api.patch<DataViewField>(`/dataviews/${props.dataview.id}/fields/${data.id}`, {
      data: {
        gridW: field.gridW,
        ...(sizable && field.gridH > 1 ? { gridH: field.gridH } : {}),
        ...(order !== null ? { gridY: order } : {})
      }
    }))
    created.push(sized)
    for (const child of childWidgets(localFields.value, field.id)) await copy(child, sized.id, child.gridY)
    return sized
  }
  let root: DataViewField | undefined
  try {
    root = await copy(source, source.parent, null)
    localFields.value = [...localFields.value, ...created]
    selectedId.value = root.id
    const area = { parent: source.parent, slot: slotOf(source) }
    await insertAt(root, { ...area, index: areaWidgets(localFields.value, area.parent, area.slot).findIndex(f => f.id === source.id) + 1 })
  } catch (error) {
    const first = root ?? created[0]
    if (first) await api.del(`/dataviews/${props.dataview.id}/fields/${first.id}`).catch(() => {})
    failed(t('designer.customDesigner.duplicateError'), error)
    await reload()
  }
}

const isCompact = useCompactUi()

/**
 * Palette | canvas | inspector, resizable and remembered per viewer
 * (`auto-save-id`). On a desktop the side panels are sized in px - a wide
 * screen gives its room to the canvas, not to them - and fold away (a
 * button in the canvas toolbar, or dragged past their minimum); the canvas
 * takes the rest. A phone or a tablet stacks the canvas over the inspector
 * (content yes, layout no), and the palette opens from "Add widget".
 */
const SPLITTER_PANELS: SplitterItem[] = [
  { id: 'palette', slot: 'palette', sizeUnit: 'px', defaultSize: 240, minSize: 180, maxSize: 360, collapsible: true, collapsedSize: 0 },
  { id: 'canvas', slot: 'canvas', minSize: 30 },
  { id: 'inspector', slot: 'inspector', sizeUnit: 'px', defaultSize: 416, minSize: 320, maxSize: 640, collapsible: true, collapsedSize: 0 }
]
const COMPACT_SPLITTER_PANELS: SplitterItem[] = [
  { id: 'canvas', slot: 'canvas', defaultSize: 55, minSize: 20 },
  { id: 'inspector', slot: 'inspector', defaultSize: 45, minSize: 20 }
]
const splitter = useTemplateRef<{ panelsRef: { isCollapsed: boolean, collapse: () => void, expand: () => void }[] }>('splitter')
function sidePanel(index: 0 | 2) {
  return splitter.value?.panelsRef[index]
}
function togglePanel(index: 0 | 2) {
  const panel = sidePanel(index)
  if (panel?.isCollapsed) panel.expand()
  else panel?.collapse()
}

/** Widgets hidden by a formula drawn faded and labeled on the canvas - the toolbar's switch, remembered on this device. */
const designerPrefs = usePagePreferences('dataview-designer', { leftTab: 'widgets' as 'widgets' | 'structure', markHidden: true })
const markHidden = computed({
  get: () => designerPrefs.markHidden,
  set: (on: boolean) => {
    designerPrefs.markHidden = on
  }
})
const leftTab = computed({
  get: () => designerPrefs.leftTab,
  set: (tab: 'widgets' | 'structure') => {
    designerPrefs.leftTab = tab
  }
})
const leftTabs = computed(() => [
  { label: t('designer.customDesigner.tabWidgets'), icon: 'i-lucide-shapes', value: 'widgets' },
  { label: t('designer.customDesigner.tabStructure'), icon: 'i-lucide-list-tree', value: 'structure' }
])

const drag = ref<CanvasDrag | null>(null)
const dropTarget = ref<CanvasDropTarget | null>(null)
function endDrag() {
  drag.value = null
  dropTarget.value = null
}

const canvasContext: CustomCanvasContext = {
  fields: allWidgets,
  selectedId,
  editable: computed(() => !isCompact.value),
  drag,
  dropTarget,
  canDrop: (area) => {
    const current = drag.value
    if (!current || isCompact.value) return false
    if (current.kind === 'move' && area.parent !== null && descendants(current.id).has(area.parent)) return false
    // The page header takes buttons and menus only; its footer buttons, menus, text, badges and boxes.
    if (area.parent === null && (area.slot === PAGE_HEADER_SLOT || area.slot === PAGE_FOOTER_SLOT)) {
      const widget = current.kind === 'new' ? current.widget : fieldById(current.id)?.widget as WidgetName | undefined
      return Boolean(widget && (area.slot === PAGE_HEADER_SLOT ? PAGE_HEADER_WIDGETS : PAGE_FOOTER_WIDGETS).includes(widget))
    }
    // A form field's Input holds one input, nothing else.
    const parent = fieldById(area.parent)
    const slotBase = area.slot?.split(':')[0]
    if (parent?.widget && slotBase && widgetDefinition(parent.widget as WidgetName).slots[slotBase]?.holds === 'input') {
      const widget = current.kind === 'new' ? current.widget : fieldById(current.id)?.widget as WidgetName | undefined
      const others = areaWidgets(localFields.value, area.parent, area.slot).filter(f => current.kind === 'new' || f.id !== current.id)
      return Boolean(widget && widgetDefinition(widget).formField && others.length === 0)
    }
    return true
  },
  drop: (target) => {
    const current = drag.value
    endDrag()
    if (current?.kind === 'new') void place(current.widget, target)
    else if (current) void move(current.id, target)
  },
  resize: (id, size, save) => {
    localFields.value = localFields.value.map(f => (f.id === id ? { ...f, ...size } : f))
    if (save) void saveField(id, { ...(size.gridW !== undefined ? { gridW: size.gridW } : {}), ...(size.gridH !== undefined ? { gridH: size.gridH } : {}) })
  },
  enter,
  remove: (id) => {
    void remove(id)
  },
  duplicate: (id) => {
    void duplicate(id)
  },
  place: (widget, target) => {
    void place(widget, target)
  },
  move: (id, target) => {
    void move(id, target)
  },
  moveBy: (id, delta) => {
    void moveBy(id, delta)
  },
  wrap: (id, container) => {
    void wrap(id, container)
  },
  rename: (id) => {
    void startRename(id)
  },
  markHidden
}
provide(CUSTOM_CANVAS_CONTEXT_KEY, canvasContext)
/**
 * The canvas's keys, on the Design tab only and never while typing (Nuxt
 * UI's shortcuts skip inputs) or with a menu or a dialog open - those keep
 * their own Escape: Delete/Backspace deletes the selected widget, Ctrl/⌘+D
 * duplicates it, Escape clears the selection, then goes one step up the
 * breadcrumb.
 */
function canvasKeys(): boolean {
  return view.value === 'design' && !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
}
function deleteSelected() {
  if (canvasKeys() && selectedId.value) void remove(selectedId.value)
}
defineShortcuts({
  delete: deleteSelected,
  backspace: deleteSelected,
  meta_d: () => {
    if (canvasKeys() && selectedId.value) void duplicate(selectedId.value)
  },
  f2: () => {
    if (canvasKeys() && selectedId.value) void startRename(selectedId.value)
  },
  alt_arrowup: () => {
    if (canvasKeys() && selectedId.value) void moveBy(selectedId.value, -1)
  },
  alt_arrowdown: () => {
    if (canvasKeys() && selectedId.value) void moveBy(selectedId.value, 1)
  },
  escape: () => {
    if (!canvasKeys()) return
    if (selectedId.value) selectedId.value = null
    else if (steps.value.length) steps.value = steps.value.slice(0, -1)
  }
})

function onPaletteDragStart(event: DragEvent, name: WidgetName) {
  drag.value = { kind: 'new', widget: name }
  event.dataTransfer?.setData('text/plain', name)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

// --- Palette -------------------------------------------------------------------

/** A phone or a tablet: the palette opens over the page, and closes once a widget is placed. */
const paletteSheetOpen = ref(false)
function placeFromSheet(name: WidgetName) {
  paletteSheetOpen.value = false
  void place(name)
}

// --- Inspector -----------------------------------------------------------------

/** A widget's config as the inspector edits it. */
function configOf(field: DataViewField): WidgetControlConfig {
  const stored = field.config as Partial<WidgetControlConfig>
  return { widget: field.widget as WidgetName, props: stored.props ?? {}, bindings: stored.bindings ?? {}, emits: stored.emits ?? {} }
}
/** Pending config saves, per widget - each saved a moment after its last change. */
const configTimers = new Map<string, ReturnType<typeof setTimeout>>()
function configPatch(field: DataViewField, config: WidgetControlConfig): Record<string, unknown> {
  const { widget: _widget, ...rest } = config
  const slot = (field.config as { slot?: string }).slot
  return { ...rest, ...(slot ? { slot } : {}) }
}
function updateConfig(fieldId: string, config: WidgetControlConfig) {
  const field = fieldById(fieldId)
  if (!field) return
  const next = configPatch(field, config)
  localFields.value = localFields.value.map(f => (f.id === fieldId ? { ...f, config: next } : f))
  clearTimeout(configTimers.get(fieldId))
  configTimers.set(fieldId, setTimeout(() => {
    configTimers.delete(fieldId)
    void saveField(fieldId, { config: next })
  }, 400))
  // Just linked to the record: its rows changing rereads it.
  const linked = (c: WidgetControlConfig) => typeof c.props?.column === 'string' && c.props.column !== ''
  if (field.widget === 'TDataView' && recordTable && linked(config) && !linked(configOf(field)) && !config.emits?.rowsChanged) {
    const updated = fieldById(fieldId)
    if (updated) refreshRecordOnRowsChanged(updated)
  }
}
/** A form field's input - edited beside the field, as one control. */
/** The form field holding `field` as its input - a field holds exactly one, so its input is replaced, never added to. */
function inputFieldOf(field: DataViewField | null | undefined): DataViewField | undefined {
  const parent = fieldById(field?.parent ?? null)
  const slotBase = field ? slotOf(field)?.split(':')[0] : undefined
  return parent?.widget && slotBase && widgetDefinition(parent.widget as WidgetName).slots[slotBase]?.holds === 'input' ? parent : undefined
}
/** The selected widget is a form field's input: its inspector also picks which input it is. */
const selectedInputField = computed(() => inputFieldOf(selected.value))

// --- The record: the page's source table (useDesignerRecord, above) ------------

/** The column a form field is bound to. */
function boundColumnOf(field: DataViewField | null | undefined): string | undefined {
  const column = (field?.config as { props?: { column?: unknown } } | undefined)?.props?.column
  return typeof column === 'string' ? column : undefined
}
/** The selected input's column, when it has an input of its own - Use the column's offers it back. */
const selectedColumnInput = computed(() => {
  const column = boundColumnOf(selectedInputField.value)
  return column && selected.value ? { column, widget: inputForColumn(column), follows: (selected.value.config as { fromColumn?: boolean }).fromColumn === true } : null
})

/** Where the new field lands - set when the setup (CustomDesignerFieldSetupModal.vue) opens. */
let fieldTarget: CanvasDropTarget = { parent: null, index: 0 }
const fieldSetupOpen = ref(false)
const fieldSetupSaving = ref(false)
function openFieldSetup(target: CanvasDropTarget) {
  fieldTarget = target
  fieldSetupOpen.value = true
}
/** The setup modal's Add: the field placed where the setup opened, selected. */
async function confirmFieldSetup(spec: FieldSetupSpec) {
  fieldSetupSaving.value = true
  try {
    const field = await placeField({ ...spec, target: fieldTarget })
    selectedId.value = field.id
    fieldSetupOpen.value = false
  } catch (error) {
    failed(t('designer.customDesigner.addFieldError'), error)
  } finally {
    fieldSetupSaving.value = false
  }
}

// --- Add fields…: the record's columns not on the page yet, several at once ---

/** The columns some form field on the page is bound to. */
const boundColumns = computed(() => new Set(localFields.value.flatMap(f => (f.widget === 'UFormField' && typeof (f.config as { props?: { column?: unknown } }).props?.column === 'string'
  ? [(f.config as { props: { column: string } }).props.column]
  : []))))
const addFieldsOpen = ref(false)
const addFieldsSaving = ref(false)
/** Where the fields go - set when the modal opens. */
let addFieldsTarget: CanvasArea | null = null
/** The columns offered - set when the modal opens; the modal keeps the ticks and labels. */
const addFieldsCandidates = ref<AddFieldCandidate[]>([])
/** The form a field goes into: the selected one, else the page's first. */
const formForFields = computed(() => (selected.value?.widget === 'UForm' ? selected.value : localFields.value.find(f => f.widget === 'UForm')) ?? null)
function openAddFields() {
  const form = formForFields.value
  addFieldsTarget = form ? { parent: form.id, slot: 'default' } : { parent: null }
  addFieldsCandidates.value = recordColumns.value
    .filter(c => !boundColumns.value.has(c.name))
    .map(c => ({ column: c.name, dataType: c.dataType, label: columnTitle(c.name) }))
  addFieldsOpen.value = true
}
async function confirmAddFields(rows: { column: string, label: string }[]) {
  const area = addFieldsTarget
  if (!area) return
  addFieldsSaving.value = true
  try {
    for (const row of rows) {
      const field = await placeField({
        label: row.label.trim() || columnTitle(row.column),
        input: inputForColumn(row.column),
        column: row.column,
        target: { ...area, index: areaWidgets(localFields.value, area.parent, area.slot).length }
      })
      selectedId.value = field.id
    }
    addFieldsOpen.value = false
  } catch (error) {
    failed(t('designer.customDesigner.addFieldsError'), error)
  } finally {
    addFieldsSaving.value = false
  }
}

/** Swaps a form field's input for another widget, keeping the Value it's bound to - its own, or (`fromColumn`) its column's again. */
async function changeInput(widget: WidgetName, fromColumn = false) {
  const old = selected.value
  const field = selectedInputField.value
  if (!old || !field || (old.widget === widget && !fromColumn)) return
  const modelValue = (old.config as { bindings?: Record<string, unknown> }).bindings?.modelValue
  try {
    // Switched in place: a field holds one input, never two for a moment.
    const { data } = await writes.track(api.patch<DataViewField>(`/dataviews/${props.dataview.id}/fields/${old.id}`, {
      data: {
        widget,
        config: { slot: 'default', props: startingProps(widget, field.id), bindings: modelValue ? { modelValue } : {}, emits: {}, ...(fromColumn && { fromColumn: true }) }
      }
    }))
    localFields.value = localFields.value.map(f => (f.id === old.id ? data : f))
  } catch (error) {
    failed(t('designer.customDesigner.changeInputError'), error)
  }
}

const nameDraft = ref('')
watch(selectedId, () => (nameDraft.value = selected.value?.label ?? ''))
function commitWidgetName() {
  const field = selected.value
  const name = nameDraft.value.trim()
  if (!field || name === (field.label ?? '')) return
  if (name && !/^[A-Za-z_$][\w$]*$/.test(name)) {
    toast.add({ title: t('designer.customDesigner.invalidName'), color: 'error' })
    nameDraft.value = field.label ?? ''
    return
  }
  void saveField(field.id, { label: name || null })
}
/** F2, or Rename in a widget's menu: selected, with the cursor in its Name (the inspector shown). */
const nameInput = useTemplateRef<{ inputRef?: HTMLInputElement }>('nameInput')
async function startRename(id: string) {
  selectedId.value = id
  if (sidePanel(2)?.isCollapsed) sidePanel(2)?.expand()
  await nextTick()
  nameInput.value?.inputRef?.focus()
  nameInput.value?.inputRef?.select()
}

/** Alt+Up / Alt+Down: one place earlier or later in its area. */
async function moveBy(id: string, delta: -1 | 1) {
  const field = fieldById(id)
  if (!field) return
  const area = areaWidgets(localFields.value, field.parent, slotOf(field))
  const from = area.findIndex(f => f.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= area.length) return
  // move() counts its own place until it leaves it: later means one past the next.
  await move(id, { parent: field.parent, slot: slotOf(field), index: delta > 0 ? to + 1 : to })
}

/** Wrap in a Card or a Box: the container placed where the widget was, the widget moved into it. */
async function wrap(id: string, container: 'UCard' | 'TBox') {
  const field = fieldById(id)
  if (!field) return
  const slot = slotOf(field)
  const index = areaWidgets(localFields.value, field.parent, slot).findIndex(f => f.id === id)
  const config = { ...newWidgetControlConfig(container), props: startingProps(container, field.parent) }
  try {
    const { data } = await writes.track(api.post<DataViewField>(`/dataviews/${props.dataview.id}/widgets`, {
      data: { widget: container, parent: field.parent, config: { props: config.props, bindings: config.bindings, emits: config.emits, ...(slot ? { slot } : {}) } }
    }))
    // The container takes the widget's place and width - a fitting widget's (0) becomes the whole row: a container fills.
    localFields.value = [...localFields.value, { ...data, gridW: field.gridW || 12 }]
    await saveField(data.id, { gridW: field.gridW || 12 })
    await insertAt(data, { parent: field.parent, slot, index: Math.max(index, 0) })
    await move(id, { parent: data.id, slot: 'default', index: 0 })
    selectedId.value = id
  } catch (error) {
    failed(t('designer.customDesigner.addWidgetError', { widget: cat.widgetLabel(container, WIDGET_CATALOG[container].label) }), error)
  }
}

/** The selection's path - its containers and slots, outermost first: cardFirma › modalFirma › body › firmaLienzo. */
const selectionPath = computed(() => {
  const parts: string[] = []
  for (let field: DataViewField | null | undefined = selected.value; field; field = fieldById(field.parent)) {
    parts.unshift(widgetLabel(field))
    const slot = slotOf(field)
    const parent = fieldById(field.parent)
    if (slot && parent && Object.keys(widgetDefinition(parent.widget as WidgetName).slots).length > 1) parts.unshift(slot.split(':').pop()!)
  }
  return parts
})

// --- Variables (useDesignerVariables) ------------------------------------------------

const { variables, selectedVariable, recordConfig, variablesAutosave, accessWarning } = useDesignerVariables({ dataview: props.dataview, failed })

// --- Form fields (useDesignerFormFields): a UFormField and its input, bound to a column or a Value ---
const { inputOptions: INPUT_OPTIONS, valueTypeFor, identifierFrom, placeField } = useDesignerFormFields({
  dataviewId: props.dataview.id,
  track: write => writes.track(write),
  fields: localFields,
  variables,
  recordRelations,
  recordJunctions,
  insertAt,
  startingProps,
  columnTitle,
  inputForColumn
})
const variablesPanel = ref<InstanceType<typeof CustomVariablesPanel> | null>(null)

/** Renaming a variable renames it in every widget bound to it; the Code is left to the author (DataViews.md §12.7). */
function renameVariable(from: string, to: string) {
  for (const field of localFields.value) {
    const bindings = (field.config as { bindings?: Record<string, { kind: string, variable?: string }> }).bindings ?? {}
    if (!Object.values(bindings).some(b => b.kind === 'variable' && b.variable === from)) continue
    const next = Object.fromEntries(Object.entries(bindings).map(([prop, b]) => [prop, b.kind === 'variable' && b.variable === from ? { ...b, variable: to } : b]))
    // Saved after the variables, so the server knows the new name when it checks the binding.
    void variablesAutosave.flush().then(() => saveField(field.id, { config: { ...field.config, bindings: next } }))
  }
  if (code.value.includes(from)) toast.add({ title: t('designer.customDesigner.renameInCode', { name: from }), color: 'warning' })
}

function usedBy(name: string): string[] {
  const users = localFields.value
    .filter(f => JSON.stringify((f.config as { bindings?: unknown }).bindings ?? {}).match(new RegExp(`"variable":"${name}"|\\{\\{\\s*vars\\.${name}\\b`)))
    .map(widgetLabel)
  const fns = declaredFunctions(code.value).filter(fn => new RegExp(`function\\s+${fn}[\\s\\S]*?vars\\.${name}\\b`).test(code.value))
  return [...users, ...fns]
}

/**
 * A select's Search window turned on (DataViews.md §9.8): its options' Resource reads every column of its
 * table, so the window shows them and searches them - a foreign key's generated one reads only its key and label. The
 * author may drop some in Variables.
 */
// The shared registry (useResourcesList) - the Resource's table, by its catalog id.
const { resources } = useResourcesList()
async function widenResource(name: string) {
  const index = variables.value.findIndex(v => v.name === name && v.kind === 'RESOURCE')
  const variable = variables.value[index] as Extract<VariableDefinition, { kind: 'RESOURCE' }> | undefined
  const target = variable && resources.value.find(r => r.id === variable.resource)
  if (!variable || !target) return
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/${target.type === 'VIEW' ? 'view' : 'table'}/${target.id}`)
    const read = String(variable.query.fields).split(',').map(f => f.trim()).filter(Boolean)
    const fields = [...read, ...data.columns.map(c => c.name).filter(c => !read.includes(c))].join(',')
    if (fields === read.join(',')) return
    variables.value.splice(index, 1, { ...variable, query: { ...variable.query, fields } })
    toast.add({ title: t('designer.customDesigner.resourceWidened', { name }), color: 'info' })
  } catch (error) {
    failed(t('designer.customDesigner.saveVariablesError'), error)
  }
}

/** "+ New variable" on a widget prop: a new variable of that kind, bound to the prop, opened in the Variables tab. */
async function newVariableForProp(field: DataViewField, kind: VariableKind, prop: string) {
  if (kind === 'RECORD') return
  view.value = 'variables'
  // The panel mounts on the tab's first visit (visitedViews) - after this tick.
  await nextTick()
  const name = variablesPanel.value?.create(kind) ?? null
  if (!name) return
  const config = configOf(field)
  updateConfig(field.id, { ...config, bindings: { ...config.bindings, [prop]: { kind: 'variable', variable: name } } })
}

// --- Code (useDesignerCode) ----------------------------------------------------------

// The DataViews the sidebar already holds (useAppsNavDataViews) - a snippet's targets.
const { dataviews: appDataviews } = useAppsNavDataViews()
const snippetContext = computed<SnippetContext>(() => ({
  variables: variables.value.map(v => ({ name: v.name, kind: v.kind })),
  controls: localFields.value.filter(f => f.widget && f.label).map(f => ({ name: f.label!, widget: f.widget as WidgetName })),
  hasRecord: Boolean(recordTable),
  dataviews: appDataviews.value.filter(d => d.id !== props.dataview.id).map(d => ({ label: d.name, value: d.slug }))
}))
const { code, codeAutosave, codeFunctions, referenceOpen, insertReference, codeEditorRef, showInCode, scaffoldHandler, snippetModal, askSnippet, newHandler, insertSnippet } = useDesignerCode({
  dataviewId: props.dataview.id,
  initialCode: props.dataview.code ?? '',
  view,
  snippetContext
})

function createWidgetHandler(field: DataViewField, event: string) {
  if (!field.widget) return
  const entry = widgetDefinition(field.widget as WidgetName)
  const emitMeta = entry.emits[event]
  newHandler(field.label || entry.label, event, `Runs on "${emitMeta?.label ?? event}" of ${widgetLabel(field)}`, emitMeta?.payload, (name) => {
    const config = configOf(fieldById(field.id) ?? field)
    updateConfig(field.id, { ...config, emits: { ...config.emits, [event]: name } })
  })
}
/** A prop that names a Code function (a form's Validate): scaffolds it and sets it. */
function createPropFunction(field: DataViewField, prop: string, item?: number) {
  if (!field.widget) return
  const entry = widgetDefinition(field.widget as WidgetName)
  const meta = entry.props[prop]
  const config = configOf(field)
  // A menu item's function: set on that item, run when it's picked.
  if (item !== undefined) {
    const items = Array.isArray(config.props[prop]) ? [...config.props[prop] as WidgetItem[]] : []
    const target = items[item]
    if (!target) return
    const name = scaffoldHandler(field.label || entry.label, target.value ?? `item${item + 1}`, `"${target.label ?? target.value}" picked in ${widgetLabel(field)}`, '{ item: { value, label } }')
    items[item] = { ...target, onSelect: name }
    updateConfig(field.id, { ...config, props: { ...config.props, [prop]: items } })
    showInCode(name)
    return
  }
  const name = scaffoldHandler(field.label || entry.label, prop, `${meta?.label ?? prop} of ${widgetLabel(field)} - ${meta?.description ?? ''}`, '{ data }')
  updateConfig(field.id, { ...config, props: { ...config.props, [prop]: name } })
  showInCode(name)
}
function createVariableHandler(variable: string, event: string, done: (name: string) => void) {
  const definition = variable === 'record' ? { kind: 'RECORD' as const } : variables.value.find(v => v.name === variable)
  if (!definition) return
  const kind = VARIABLE_CATALOG[definition.kind]
  const payload = (kind.emits as Record<string, { payload?: string }>)[event]?.payload
  newHandler(variable, event, `Runs on "${event}" of the ${kind.label} ${variable}`, payload, done)
}

// --- "Page events" (CustomDesignerCodeToolbar.vue) ------------------------------------------
//
// The events of the page itself, not of one widget or variable: `onLoad`,
// run by its name once the variables have loaded, and - with a record
// table - the record's (load, before:save, save), bound in
// `view_config.record.emits`. One already in the code is jumped to; one
// that isn't is scaffolded (a snippet may write its body), bound when it's
// the record's, and shown.

const ON_LOAD = 'onLoad'
function addOnLoad() {
  if (codeFunctions.value.includes(ON_LOAD)) return showInCode(ON_LOAD)
  const what = 'Runs once, when the page\'s variables have loaded'
  askSnippet('handler', what, (lines) => {
    code.value = `${code.value.trimEnd()}\n${lines ? handlerWithBody(ON_LOAD, what, undefined, lines) : handlerScaffold(ON_LOAD, what, undefined)}`
    showInCode(ON_LOAD)
  })
}
function addRecordEvent(event: string) {
  const bound = recordConfig.value?.emits?.[event]
  if (bound && codeFunctions.value.includes(bound)) return showInCode(bound)
  createVariableHandler('record', event, (name) => {
    recordConfig.value = { ...recordConfig.value, emits: { ...recordConfig.value?.emits, [event]: name } }
  })
}

// --- Page contract ---------------------------------------------------------------------

async function flush() {
  const pending = [...configTimers.keys()]
  for (const id of pending) clearTimeout(configTimers.get(id))
  configTimers.clear()
  await Promise.all(pending.map((id) => {
    const field = fieldById(id)
    return field ? saveField(id, { config: field.config }) : undefined
  }))
  await Promise.all([writes.flush(), variablesAutosave.flush(), codeAutosave.flush()])
}
function hasUnsavedWork(): boolean {
  return configTimers.size > 0 || [writes, variablesAutosave, codeAutosave].some(a => a.status.value === 'saving')
}
const saveStatus = computed<AutosaveStatus>(() => {
  const states = [writes.status.value, variablesAutosave.status.value, codeAutosave.status.value]
  if (states.includes('error')) return 'error'
  if (states.includes('saving')) return 'saving'
  if (states.includes('saved')) return 'saved'
  return 'idle'
})
onBeforeUnmount(() => {
  void flush()
})
defineExpose({ flush, hasUnsavedWork, saveStatus })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <!-- Design -->
    <USplitter
      v-show="view === 'design'"
      id="dataview-designer"
      :key="isCompact ? 'compact' : 'wide'"
      ref="splitter"
      :items="isCompact ? COMPACT_SPLITTER_PANELS : SPLITTER_PANELS"
      :orientation="isCompact ? 'vertical' : 'horizontal'"
      :auto-save-id="isCompact ? 'dataview-designer-compact' : 'dataview-designer'"
      class="min-h-0 flex-1"
    >
      <template #palette>
        <!-- Widgets to place, or the page's Structure - the tab chosen remembered on this device. -->
        <div class="flex w-full min-w-0 flex-col gap-2">
          <UTabs
            v-model="leftTab"
            :items="leftTabs"
            :content="false"
            size="sm"
            class="w-full"
          />
          <div class="flex min-h-0 flex-1 overflow-y-auto pe-1">
            <CustomDesignerPalette
              v-if="leftTab === 'widgets'"
              draggable
              @place="place"
              @dragstart="onPaletteDragStart"
              @dragend="endDrag"
            />
            <CustomDesignerTree
              v-else
              :view-type="dataview.viewType"
            />
          </div>
        </div>
      </template>

      <template #canvas>
        <div
          class="flex w-full min-w-0 flex-col gap-2"
          :class="isCompact ? 'pb-3' : 'px-3'"
        >
          <CustomDesignerCanvasToolbar
            v-model:mark-hidden="markHidden"
            :compact="isCompact"
            :palette-collapsed="sidePanel(0)?.isCollapsed ?? false"
            :inspector-collapsed="sidePanel(2)?.isCollapsed ?? false"
            :breadcrumb="breadcrumb"
            :current-width="currentWidth"
            :layout-disabled="layoutWidgets.length === 0"
            :can-undo-columns="!!columnsUndo"
            :has-record="Boolean(recordTable)"
            @toggle-palette="togglePanel(0)"
            @toggle-inspector="togglePanel(2)"
            @apply-columns="applyColumns"
            @undo-columns="undoColumns"
            @add-widget="paletteSheetOpen = true"
            @add-fields="openAddFields"
          >
            <template #open>
              <UPopover v-model:open="openSettingsOpen">
                <UButton
                  icon="i-lucide-app-window"
                  :label="openSettingsLabel"
                  :aria-label="t('designer.formSettings.howItOpens')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                />
                <template #content>
                  <div class="flex w-80 flex-col gap-3 p-3">
                    <p class="text-sm font-medium">
                      {{ t('designer.formSettings.howItOpens') }}
                    </p>
                    <DataViewOpenSettings
                      v-model:edit-presentation="editPresentation"
                      v-model:edit-size="editSize"
                      v-model:edit-side="editSide"
                      v-model:form-view-mode="formViewMode"
                      v-model:master-detail-open-with="masterDetailOpenWith"
                      v-model:new-record-label="newRecordLabel"
                      v-model:page-content-width="pageContentWidth"
                      v-model:page-content-align="pageContentAlign"
                      v-model:fit-to-screen="fitToScreen"
                      :dataview="dataview"
                      :name="dataview.name"
                    />
                  </div>
                </template>
              </UPopover>
            </template>
          </CustomDesignerCanvasToolbar>
          <!-- A drag that ends anywhere else leaves no drop line behind. -->
          <div
            class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-default bg-elevated/30 px-4 pt-7 pb-4"
            @dragend="endDrag"
            @drop="endDrag"
          >
            <template v-if="!step">
              <!-- A CUSTOM page's header: its buttons and menus show in the App page's own header, beside its title. -->
              <div
                v-if="dataview.viewType === 'CUSTOM'"
                class="mb-4 flex flex-col gap-1.5 border-b border-default pb-4"
              >
                <p class="text-xs text-muted">
                  <span class="font-medium">{{ t('designer.customDesigner.pageHeader') }}</span> - {{ t('designer.customDesigner.pageHeaderHelp') }}
                </p>
                <CustomCanvasArea
                  :parent="null"
                  :slot-name="PAGE_HEADER_SLOT"
                  :label="t('designer.customDesigner.pageHeader')"
                  justify="end"
                />
              </div>
              <CustomCanvasArea
                :parent="null"
                :label="t('designer.customDesigner.thePage')"
              />
              <!-- A CUSTOM page's footer: pinned under the page in the App - here too, under what scrolls. -->
              <div
                v-if="dataview.viewType === 'CUSTOM'"
                class="sticky -bottom-4 z-10 -mx-4 mt-4 flex flex-col gap-1.5 border-t border-default bg-default px-4 pt-3 pb-4"
              >
                <p class="text-xs text-muted">
                  <span class="font-medium">{{ t('designer.customDesigner.pageFooter') }}</span> - {{ t('designer.customDesigner.pageFooterHelp') }}
                </p>
                <CustomCanvasArea
                  :parent="null"
                  :slot-name="PAGE_FOOTER_SLOT"
                  :label="t('designer.customDesigner.pageFooter')"
                />
              </div>
            </template>
            <div
              v-else-if="step.mode === 'focus' && stepField"
              class="widget-area"
            >
              <CustomCanvasItem
                :field="stepField"
                class="basis-full"
              />
            </div>
            <div
              v-else-if="stepField"
              class="flex w-full flex-col divide-y divide-default rounded-lg border border-default bg-default shadow-lg"
              :class="ownFrameClass"
            >
              <div
                v-for="area in ownSlots"
                :key="area.slot"
                class="flex flex-col gap-2 p-4"
                :class="area.slot === 'body' ? 'min-h-40' : undefined"
              >
                <p class="text-xs font-medium text-muted">
                  {{ area.label }}
                </p>
                <CustomCanvasArea
                  :parent="stepField.id"
                  :slot-name="area.slot"
                  :label="area.label"
                  :justify="area.inline ? 'end' : undefined"
                />
              </div>
            </div>
          </div>
          <!-- Where the selection sits: its containers and slots. -->
          <p
            v-if="selectionPath.length > 1"
            class="truncate font-mono text-xs text-muted"
          >
            {{ selectionPath.join(' › ') }}
          </p>
        </div>
      </template>

      <template #inspector>
        <div
          class="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-default"
          :class="isCompact ? 'border-t pt-3' : 'border-l ps-4 pe-3'"
        >
          <UEmpty
            v-if="!selected || !selected.widget"
            icon="i-lucide-mouse-pointer"
            :title="t('designer.customDesigner.noSelectionTitle')"
            :description="t('designer.customDesigner.noSelectionDescription')"
            variant="naked"
          />
          <template v-else>
            <WidgetInspector
              :key="selected.id"
              :model-value="configOf(selected)"
              :variables="variables.map(v => ({ name: v.name, kind: v.kind }))"
              :code-functions="codeFunctions"
              :columns="recordColumns"
              :relations="recordRelations"
              :record-table="recordTableName"
              :junctions="recordJunctions"
              :dataview-id="dataview.id"
              :resource-fields="resourceFields"
              :resource-columns="resourceColumns"
              :resource-presentation="resourcePresentation"
              :record-presentation="recordPresentation"
              :presentation-link="presentationLink"
              :presentation-resource="dataview.sourceResource ?? undefined"
              @presentation-saved="emit('presentationSaved')"
              @update:model-value="updateConfig(selected.id, $event)"
              @create-handler="createWidgetHandler(selected, $event)"
              @create-function="(prop: string, item?: number) => createPropFunction(selected!, prop, item)"
              @open-handler="showInCode"
              @widen-resource="widenResource"
              @new-variable="(kind, prop) => newVariableForProp(selected!, kind, prop)"
            >
              <template #actions>
                <UDropdownMenu
                  :items="widgetMenu(canvasContext, selected)"
                  :content="{ align: 'end' }"
                >
                  <UButton
                    icon="i-lucide-ellipsis-vertical"
                    :aria-label="t('designer.customDesigner.widgetActions')"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                  />
                </UDropdownMenu>
              </template>
              <template #identity>
                <UFormField
                  :label="t('common.name')"
                  :description="t('designer.customDesigner.nameHelp', { example: 'dataview.controls.name.open()' })"
                >
                  <UInput
                    ref="nameInput"
                    v-model="nameDraft"
                    class="w-full font-mono"
                    @blur="commitWidgetName"
                    @keydown.enter="commitWidgetName"
                  />
                </UFormField>
                <UFormField
                  v-if="selectedInputField"
                  :label="t('designer.customDesigner.input')"
                  :description="selectedColumnInput?.follows ? t('designer.customDesigner.inputFromColumn') : t('designer.customDesigner.inputHelp')"
                >
                  <USelectMenu
                    :model-value="selected.widget as WidgetName"
                    :items="INPUT_OPTIONS"
                    value-key="value"
                    class="w-full"
                    @update:model-value="(widget: WidgetName) => changeInput(widget)"
                  />
                  <UButton
                    v-if="selectedColumnInput && !selectedColumnInput.follows"
                    :label="t('designer.customDesigner.useColumnInput', { input: cat.widgetLabel(selectedColumnInput.widget, widgetDefinition(selectedColumnInput.widget).label) })"
                    icon="i-lucide-undo-2"
                    variant="link"
                    size="xs"
                    class="mt-1 px-0"
                    @click="changeInput(selectedColumnInput.widget, true)"
                  />
                </UFormField>
              </template>
            </WidgetInspector>
          </template>
        </div>
      </template>
    </USplitter>

    <!-- Variables - mounted on first visit (visitedViews), kept after -->
    <div
      v-if="visitedViews.has('variables')"
      v-show="view === 'variables'"
      class="flex min-h-0 flex-1"
    >
      <CustomVariablesPanel
        ref="variablesPanel"
        v-model="variables"
        v-model:selected="selectedVariable"
        v-model:record="recordConfig"
        :record-table="recordTable ? `${dataview.sourceResourceSchema}.${dataview.sourceResourceName}` : null"
        :code-functions="codeFunctions"
        :used-by="usedBy"
        :access-warning="accessWarning"
        @create-handler="createVariableHandler"
        @open-handler="showInCode"
        @rename="renameVariable"
      />
    </div>

    <!-- Code - Monaco mounted on first visit (visitedViews), kept after -->
    <div
      v-if="visitedViews.has('code')"
      v-show="view === 'code'"
      class="flex min-h-0 flex-1 flex-col gap-2"
    >
      <CustomDesignerCodeToolbar
        :code-functions="codeFunctions"
        :has-record="Boolean(recordTable)"
        :record-emits="recordConfig?.emits"
        @add-on-load="addOnLoad"
        @add-record-event="addRecordEvent"
        @insert-snippet="insertSnippet"
        @open-reference="referenceOpen = true"
      />
      <CodeEditor
        ref="codeEditorRef"
        v-model="code"
        min-height="100%"
        class="min-h-0 flex-1"
      />
    </div>

    <CodeReferenceSlideover
      v-model:open="referenceOpen"
      @insert="insertReference"
    />

    <USlideover
      v-if="isCompact"
      v-model:open="paletteSheetOpen"
      side="left"
      :title="t('designer.customDesigner.addWidget')"
      :description="t('designer.customDesigner.addWidgetDescription')"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <UTabs
            v-model="leftTab"
            :items="leftTabs"
            :content="false"
            size="sm"
            class="w-full"
          />
          <CustomDesignerPalette
            v-if="leftTab === 'widgets'"
            :draggable="false"
            @place="placeFromSheet"
          />
          <CustomDesignerTree
            v-else
            :view-type="dataview.viewType"
            @selected="paletteSheetOpen = false"
          />
        </div>
      </template>
    </USlideover>

    <!-- Add fields…: several columns of the record at once, each a form field with its input. -->
    <CustomDesignerAddFieldsModal
      v-model:open="addFieldsOpen"
      :candidates="addFieldsCandidates"
      :description="formForFields ? t('designer.customDesigner.addFields.descriptionIn', { widget: widgetLabel(formForFields) }) : t('designer.customDesigner.addFields.description')"
      :saving="addFieldsSaving"
      @confirm="confirmAddFields"
    />

    <SnippetModal
      v-model:open="snippetModal.open"
      :mode="snippetModal.mode"
      :subtitle="snippetModal.subtitle"
      :context="snippetContext"
      @confirm="snippetModal.onConfirm"
    />

    <!-- A new form field: its label, its input, and the Value it keeps its value in. -->
    <!-- A new form field: its label, its input, and the Value it keeps its value in. -->
    <CustomDesignerFieldSetupModal
      v-model:open="fieldSetupOpen"
      :columns="recordColumns"
      :junctions="recordJunctions"
      :input-options="INPUT_OPTIONS"
      :column-title="columnTitle"
      :input-for-column="inputForColumn"
      :identifier-from="identifierFrom"
      :value-type-for="valueTypeFor"
      :saving="fieldSetupSaving"
      @confirm="confirmFieldSetup"
    />
  </div>
</template>
