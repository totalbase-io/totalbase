<script setup lang="ts">
/**
 * A dashboard widget's inspector (Dashboards.md §10.4, D2) - the widget drawer's right column, laid out
 * as the page designer's: its header (icon, name, description, "⋮"), Properties and Styles. All of it from the widget
 * catalog (@totalbase/tb-catalog): Type marks which types fit what the query returns (the others greyed, with why) and
 * keeps the equivalent roles on a switch; Data has a field per role - only the columns of a kind it takes, each with
 * its type and origin, "Automatic: total" and its rule while unset, an error when the query stopped returning the one
 * chosen; then the type's own props, each in its catalog section - Format, Appearance, Series, Axes, Thresholds (and
 * reference lines), Events (the click), Zoom & export (tanda 2b: D4, D5, D6, D8, D28). Tanda 3 adds a pivot's
 * aggregates and row order, a scatter's x/y axes and reference axis, a combo's own series defaults (the first bars on
 * the left, the rest lines on the right) and a type's whole-contract problem (a combo's two values). Styles: the page
 * catalog's common block.
 *
 * A presentation widget (D3) has no Type or roles: its page widget's own props instead, edited by the page
 * designer's inspector (WidgetInspector.vue, `bare`) - their formulas over `formulaFields`. Any widget's title may be
 * a formula (`bindings.title`, its 🔗).
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import {
  COMMON_STYLE_PROPS,
  DASHBOARD_WIDGET_GROUPS,
  convertDashboardConfig,
  DASHBOARD_TITLE_BINDING,
  DASHBOARD_WIDGET_CARD_PROPS,
  dashboardRolesProblem,
  dashboardValueKind,
  dashboardWidgetDefinition,
  resolveDashboardRoles,
  type DashboardPropSection,
  type DashboardRole,
  type DashboardWidgetProp,
  type DashboardWidgetType,
  type TableColumnSettings,
  type WidgetControlConfig,
  type WidgetPropBinding
} from '@totalbase/tb-catalog'
import type { DashboardQueryColumn, DashboardVariable } from '~/types/dashboard'
import { DASHBOARD_WIDGET_PALETTE, useDashboardCatalogText } from '~/types/dashboard'
import type { CatalogColumn, RoleColor } from '~/types/permission'

const props = defineProps<{
  /** The query's result columns - empty until it runs. */
  columns: DashboardQueryColumn[]
  /** What a formula reads (`vars.<name>`, `user.<field>`, `row.<column>`) - the Bind modal's Fields. */
  formulaFields?: CatalogColumn[]
  /** The dashboard's variables - a click's FILTER, a threshold's `{variable}`. Unset: read from `formulaFields` (`vars.<name>`). */
  variables?: DashboardVariable[]
  /** The query's rows - the Series column's values, in long format. Unset: a series value is typed. */
  rows?: Record<string, unknown>[]
}>()
const type = defineModel<DashboardWidgetType>('type', { required: true })
const label = defineModel<string>('label', { required: true })
const config = defineModel<Record<string, unknown>>('config', { required: true })

const { t, te } = useI18n()
const catalog = useDashboardCatalogText()
const definition = computed(() => dashboardWidgetDefinition(type.value))
const ran = computed(() => props.columns.length > 0)
/** A presentation widget's page widget (D3) - none for a data widget. */
const page = computed(() => definition.value.page)

// --- Formulas: its title's (any widget), a presentation widget's props' ----

const bindings = computed<Record<string, WidgetPropBinding>>(() => (config.value.bindings && typeof config.value.bindings === 'object' ? config.value.bindings as Record<string, WidgetPropBinding> : {}))
function setBindings(next: Record<string, WidgetPropBinding>) {
  const { bindings: _old, ...rest } = config.value
  config.value = Object.keys(next).length ? { ...rest, bindings: next } : rest
}
const titleFormula = computed(() => {
  const binding = bindings.value[DASHBOARD_TITLE_BINDING]
  return binding?.kind === 'formula' ? binding.formula : ''
})
function setTitleFormula(formula: string) {
  const { [DASHBOARD_TITLE_BINDING]: _old, ...others } = bindings.value
  setBindings(formula.trim() ? { ...others, [DASHBOARD_TITLE_BINDING]: { kind: 'formula', formula } } : others)
}
/** Its config as a page control's - what WidgetInspector edits: its props, its bindings but the title's. */
const pageControl = computed<WidgetControlConfig>({
  get: () => {
    const { [DASHBOARD_TITLE_BINDING]: _title, ...own } = bindings.value
    const literal = config.value.props && typeof config.value.props === 'object' ? config.value.props as Record<string, unknown> : {}
    return { widget: page.value!, props: literal, bindings: own, emits: {} }
  },
  set: (control) => {
    const title = bindings.value[DASHBOARD_TITLE_BINDING]
    const { props: _props, bindings: _bindings, ...rest } = config.value
    const next: Record<string, WidgetPropBinding> = { ...control.bindings, ...(title ? { [DASHBOARD_TITLE_BINDING]: title } : {}) }
    config.value = {
      ...rest,
      ...(Object.keys(control.props).length ? { props: control.props } : {}),
      ...(Object.keys(next).length ? { bindings: next } : {})
    }
  }
})

const tab = ref<'props' | 'styles'>('props')
const style = computed<Record<string, unknown>>(() => (config.value.style && typeof config.value.style === 'object' ? config.value.style as Record<string, unknown> : {}))
const styleCount = computed(() => Object.keys(style.value).filter(key => key in COMMON_STYLE_PROPS).length)
const TABS = computed(() => [
  { label: t('dashboards.inspector.tabs.props'), value: 'props' },
  { label: t('dashboards.inspector.tabs.styles'), value: 'styles', badge: styleCount.value || undefined }
])

// --- Type: which fit what the query returns -------------------------------

/** A whole-contract problem (a combo's two values), in the UI's language - its fixed code names the text. */
function problemText(problem: { code: string, message: string }): string {
  const key = `dashboards.inspector.problems.${problem.code}`
  return te(key) ? t(key) : problem.message
}
/** Why a type doesn't fit the query's columns - its roles', else its contract's - none when it does (or the query hasn't run). */
function misfit(candidate: DashboardWidgetType): string | null {
  if (!ran.value || candidate === type.value) return null
  const converted = convertDashboardConfig(type.value, candidate, config.value)
  const { roles: candidateRoles, errors } = resolveDashboardRoles(candidate, converted, props.columns)
  if (errors[0]) return errors[0]
  const problem = dashboardRolesProblem(candidate, converted, candidateRoles)
  return problem ? problemText(problem) : null
}
interface TypeItem { label: string, value?: DashboardWidgetType, icon?: string, disabled?: boolean, description?: string, type?: 'label' }
/** By group, as the widget bar: the types that don't fit greyed, with why. */
const typeItems = computed<TypeItem[][]>(() => Object.keys(DASHBOARD_WIDGET_GROUPS).flatMap((group) => {
  // A data widget switches to another data widget - never to a presentation one.
  const entries = DASHBOARD_WIDGET_PALETTE.filter(e => e.group === group && dashboardWidgetDefinition(e.type).query && !dashboardWidgetDefinition(e.type).page)
  if (entries.length === 0) return []
  return [[
    { type: 'label' as const, label: catalog.groupLabel(group as keyof typeof DASHBOARD_WIDGET_GROUPS) },
    ...entries.map((entry) => {
      const reason = misfit(entry.type)
      return { label: catalog.widgetLabel(entry.type), value: entry.type, icon: entry.icon, disabled: reason !== null, description: reason ?? undefined }
    })
  ]]
}))
function setType(next: DashboardWidgetType) {
  if (next === type.value) return
  // Its roles carried to their equivalents (Category → Label, Values → Value), the props both types have.
  config.value = { ...convertDashboardConfig(type.value, next, config.value), ...(config.value.style ? { style: config.value.style } : {}) }
  type.value = next
}

// --- Data: a field per role -----------------------------------------------

const roles = computed(() => Object.entries(definition.value.roles) as [string, DashboardRole][])
const resolved = computed(() => resolveDashboardRoles(type.value, config.value, props.columns))
/** The current type's whole-contract problem (a combo with one value) - shown on Type. */
const typeProblem = computed(() => {
  if (!ran.value) return undefined
  const problem = dashboardRolesProblem(type.value, config.value, resolved.value.roles)
  return problem ? problemText(problem) : undefined
})
const assigned = (id: string): string[] => {
  const value = (config.value.roles as Record<string, unknown> | undefined)?.[id]
  return (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => typeof v === 'string')
}
function columnText(column: DashboardQueryColumn): string {
  const origin = column.origin ? ` · ${column.origin.table}.${column.origin.column}` : ''
  return `${column.dataType}${origin}`
}
/** The columns a role takes - of a kind it accepts, or chooses by hand. A waterfall's Total: the true/false ones first. */
function roleItems(id: string, role: DashboardRole) {
  const kinds = [...role.accepts, ...(role.manual ?? [])]
  const columns = props.columns.filter(c => !c.name.startsWith('_') && kinds.includes(dashboardValueKind(c)))
  const isBoolean = (c: DashboardQueryColumn) => c.dataType.toLowerCase() === 'boolean'
  const ordered = id === 'total' ? [...columns.filter(isBoolean), ...columns.filter(c => !isBoolean(c))] : columns
  return ordered.map(c => ({ label: c.name, value: c.name, description: columnText(c) }))
}
function setRole(id: string, value: string | string[] | undefined) {
  const others = Object.entries((config.value.roles as Record<string, unknown> | undefined) ?? {}).filter(([key]) => key !== id)
  const empty = value === undefined || (Array.isArray(value) && value.length === 0)
  const current = Object.fromEntries(empty ? others : [...others, [id, value]])
  const { roles: _roles, ...rest } = config.value
  config.value = Object.keys(current).length ? { ...rest, roles: current } : rest
}
/** "Automatic: total" and its rule, while the role is unset. */
function roleHint(id: string, role: DashboardRole): string {
  if (!ran.value) return t('dashboards.inspector.runToListColumns')
  const auto = resolved.value.roles[id]
  if (assigned(id).length > 0) return catalog.roleDescription(type.value, id)
  // An optional role with nothing automatic (a Tooltip, a Total chosen by hand): what it does.
  if (!auto) return role.required ? t('dashboards.inspector.noAutomatic') : catalog.roleDescription(type.value, id)
  return t('dashboards.inspector.automatic', { columns: auto.columns.join(', '), rule: t(`dashboards.inspector.rules.${role.default}`) })
}
/** A column chosen that the query no longer returns - or no longer of a kind the role takes. */
function roleError(id: string): string | undefined {
  if (!ran.value) return undefined
  const missing = assigned(id).filter(name => !props.columns.some(c => c.name === name))
  if (missing.length) return t('dashboards.inspector.missingColumn', { columns: missing.join(', ') })
  const prefix = `${dashboardWidgetDefinition(type.value).label}'s ${definition.value.roles[id]!.label}:`
  return resolved.value.errors.find(e => e.startsWith(prefix)) ? t('dashboards.inspector.wrongKind') : undefined
}

// A multi-column role's order: dragged.
const dragging = ref<{ role: string, index: number } | null>(null)
function drop(role: string, index: number) {
  if (!dragging.value || dragging.value.role !== role) return
  const list = [...assigned(role)]
  const [moved] = list.splice(dragging.value.index, 1)
  list.splice(index, 0, moved!)
  dragging.value = null
  setRole(role, list)
}

// --- Props ------------------------------------------------------------------

/** The inspector's sections, in order - each shown only when the type has props there. */
const SECTIONS: DashboardPropSection[] = ['format', 'appearance', 'series', 'axes', 'thresholds', 'events', 'zoomExport']
/** The structured props - each its own editor, without the "Back to the default" of a single value. */
const STRUCTURED = ['tableColumns', 'series', 'axes', 'thresholds', 'references', 'click', 'aggregates', 'pivotSort']
const propsOf = (section: DashboardPropSection) => Object.entries(definition.value.props).filter(([, p]) => (p.section ?? 'appearance') === section) as [string, DashboardWidgetProp][]
const sections = computed(() => SECTIONS.filter(section => propsOf(section).length > 0))
function setProp(key: string, value: unknown) {
  const empty = value === undefined || value === null || value === ''
  const { [key]: _old, ...rest } = config.value
  config.value = empty ? rest : { ...rest, [key]: value }
}
const mobileItems = computed(() => ['AUTO', 'FULL', 'HALF', 'HIDDEN'].map(value => ({ value, label: t(`dashboards.inspector.card.mobileOptions.${value}`) })))
const columnItems = computed(() => props.columns.map(c => ({ label: c.name, value: c.name, description: columnText(c) })))
/** A select prop's options in the UI's language (`dashboards.inspector.options.<prop>.<VALUE>`), else the value. */
function optionItems(key: string, prop: DashboardWidgetProp) {
  return (prop.options ?? []).map((value) => {
    const text = `dashboards.inspector.options.${key}.${value}`
    return { value, label: te(text) ? t(text) : value }
  })
}
/** A prop's value - unset, its default (what it draws with). */
const shown = (key: string, prop: DashboardWidgetProp): unknown => config.value[key] ?? prop.default
const colorValue = (key: string, prop: DashboardWidgetProp) => shown(key, prop) as RoleColor | undefined
const numberValue = (key: string, prop: DashboardWidgetProp) => shown(key, prop) as number | undefined
const textValue = (key: string, prop: DashboardWidgetProp) => shown(key, prop) as string | undefined
/** A pivot's Values, resolved - each needs its aggregate; the row order picks one. */
const pivotValues = computed(() => resolved.value.roles.values?.columns ?? [])
/** TABLE: columns it never shows (`_*`, the row color column) - not offered in its per-column settings. */
const tableExcluded = computed(() => props.columns.filter(c => c.name.startsWith('_') || c.name === config.value.colorColumn).map(c => c.name))

function setStyle(name: string, value: unknown) {
  const others = Object.entries(style.value).filter(([key]) => key !== name)
  const next = Object.fromEntries(value === undefined || value === null || value === '' ? others : [...others, [name, value]])
  setProp('style', Object.keys(next).length ? next : undefined)
}

/**
 * The value column's format, when its origin's presentation has one (Dashboards.md §2.3): shown
 * inherited, greyed, with Edit in the table - over the drawer, the column's own panel.
 */
const valueColumn = computed(() => {
  const id = ['value', 'values', 'y', 'size'].find(r => resolved.value.roles[r])
  const name = id ? resolved.value.roles[id]!.columns[0] : undefined
  return props.columns.find(c => c.name === name)
})
const inheritedFormat = computed(() => valueColumn.value?.presentation?.displayFormat)
const editingColumn = ref(false)
const ownFormat = computed(() => (typeof config.value.displayFormat === 'string' ? config.value.displayFormat : undefined))

// --- Series, axes, thresholds, references, click (D4, D5, D6) ---------------------------------------

/** The dashboard's variables, by name - its own list, else what the formulas read (`vars.<name>`, typed by its type). */
const dashboardVariables = computed(() => props.variables
  ? props.variables.map(v => ({ value: v.name, label: v.label || v.name, type: v.type as string }))
  : (props.formulaFields ?? []).filter(f => /^vars\.[^.]+$/.test(f.name)).map(f => ({ value: f.name.slice(5), label: f.name.slice(5), type: f.dataType.toUpperCase() })))
/** What a threshold or a reference may start from: NUMBER and SELECT variables, the query's number columns. */
const sourceVariables = computed(() => dashboardVariables.value.filter(v => v.type === 'NUMBER' || v.type === 'SELECT'))
const numberColumns = computed(() => props.columns.filter(c => dashboardValueKind(c) === 'number').map(c => c.name))

/** A chart's own mark - its series' type while unset. */
const CHART_MARK: Partial<Record<DashboardWidgetType, 'bar' | 'line' | 'area'>> = { BAR: 'bar', BAR_HORIZONTAL: 'bar', LINE: 'line', AREA: 'area' }
const chartMark = computed(() => CHART_MARK[type.value] ?? 'bar')
/** Long format: the Series column - its values are the series (a scatter's Group). */
const seriesColumn = computed(() => (resolved.value.roles.series ?? resolved.value.roles.group)?.columns[0])
const columnOf = (name?: string) => props.columns.find(c => c.name === name)
/** The series, in order, with what each inherits: the value column's title and format, or the Series column's value labels and colors. */
const seriesList = computed(() => {
  if (seriesColumn.value) {
    const name = seriesColumn.value
    const options = columnOf(name)?.presentation?.options ?? {}
    const format = columnOf(resolved.value.roles.values?.columns[0])?.presentation?.displayFormat
    const values = [...new Set((props.rows ?? []).map(row => row[name]).filter(v => v !== null && v !== undefined).map(String))]
    return values.map(value => ({ name: value, label: options[value]?.label ?? value, color: options[value]?.color, format }))
  }
  return (resolved.value.roles.values?.columns ?? []).map((name) => {
    const presentation = columnOf(name)?.presentation
    return { name, label: presentation?.label ?? name, format: presentation?.displayFormat }
  })
})
const seriesSettings = computed<Record<string, { axis?: string, displayFormat?: string }>>(() => (config.value.series && typeof config.value.series === 'object' ? config.value.series as Record<string, { axis?: string, displayFormat?: string }> : {}))
/** A combo's own series defaults (D11): the first value as bars on the left, the rest as lines on the right. */
const seriesDefaults = computed<Record<string, { type?: 'bar' | 'line', axis?: 'left' | 'right' }> | undefined>(() => (type.value === 'COMBO' && !seriesColumn.value
  ? Object.fromEntries(seriesList.value.map((s, index) => [s.name, index === 0 ? { type: 'bar', axis: 'left' } : { type: 'line', axis: 'right' }]))
  : undefined))
const seriesAxis = (name: string) => seriesSettings.value[name]?.axis ?? seriesDefaults.value?.[name]?.axis ?? 'left'
/** A value axis' format while it has none: its first series' (own, else its column's), else the widget's. */
function axisFormat(axis: 'left' | 'right'): string | undefined {
  const first = seriesList.value.find(s => seriesAxis(s.name) === axis)
  return (first ? seriesSettings.value[first.name]?.displayFormat ?? first.format : undefined) ?? ownFormat.value ?? inheritedFormat.value
}
const usesRightAxis = computed(() => seriesList.value.some(s => seriesAxis(s.name) === 'right') || Object.values(seriesSettings.value).some(s => s?.axis === 'right'))
/** A scatter's axis format while it has none: its role's column's. */
const roleFormat = (role: string) => columnOf(resolved.value.roles[role]?.columns[0])?.presentation?.displayFormat

const menu = computed<DropdownMenuItem[][]>(() => [[
  { label: t('dashboards.inspector.restoreDefaults'), icon: 'i-lucide-rotate-ccw', onSelect: () => {
    // Its card's settings and its title's formula stay - they are not its type's.
    const kept = Object.fromEntries(Object.entries(config.value).filter(([key]) => key === 'style' || key in DASHBOARD_WIDGET_CARD_PROPS))
    const title = bindings.value[DASHBOARD_TITLE_BINDING]
    config.value = title ? { ...kept, bindings: { [DASHBOARD_TITLE_BINDING]: title } } : kept
  } }
]])
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- What the widget is, and what acts on it. -->
    <div class="flex items-start gap-2">
      <UIcon
        :name="definition.icon"
        class="mt-0.5 size-4 shrink-0 text-muted"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">
          {{ catalog.widgetLabel(type) }}
        </p>
        <p class="text-xs text-muted">
          {{ catalog.widgetDescription(type) }}
        </p>
      </div>
      <UDropdownMenu
        :items="menu"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('dashboards.inspector.actions')"
        />
      </UDropdownMenu>
    </div>
    <UTabs
      v-model="tab"
      :items="TABS"
      :content="false"
      size="xs"
    />

    <template v-if="tab === 'props'">
      <UFormField
        v-if="!page"
        :label="t('common.type')"
        :description="ran ? t('dashboards.inspector.typeHelp') : t('dashboards.inspector.runToListColumns')"
        :error="typeProblem"
      >
        <USelectMenu
          :model-value="type"
          :items="typeItems"
          value-key="value"
          :icon="definition.icon"
          class="w-full"
          @update:model-value="(v: unknown) => setType(v as DashboardWidgetType)"
        />
      </UFormField>
      <UFormField
        :label="t('dashboards.inspector.title')"
        :description="t('dashboards.inspector.titleHelp')"
      >
        <div class="flex gap-1">
          <UInput
            v-model="label"
            class="min-w-0 flex-1"
          />
          <BindingButton
            :model-value="titleFormula"
            kind="text"
            :label="t('dashboards.inspector.title')"
            :columns="formulaFields"
            beside-input
            @update:model-value="setTitleFormula"
          />
        </div>
        <p
          v-if="titleFormula"
          class="mt-1 truncate font-mono text-xs text-muted"
        >
          = {{ titleFormula }}
        </p>
      </UFormField>

      <!-- A presentation widget: its page widget's own props, as the page designer edits them. -->
      <template v-if="page">
        <USeparator :label="t('dashboards.inspector.sections.appearance')" />
        <WidgetInspector
          v-model="pageControl"
          :columns="formulaFields"
          bare
        />
      </template>

      <template v-if="roles.length">
        <USeparator :label="t('dashboards.inspector.data')" />
        <UFormField
          v-for="[id, role] in roles"
          :key="id"
          :label="catalog.roleLabel(type, id)"
          :description="roleHint(id, role)"
          :error="roleError(id)"
          :required="role.required"
        >
          <!-- One or more: its columns in order, dragged; a picker adds one. -->
          <div
            v-if="role.multiple"
            class="flex flex-col gap-1"
          >
            <div
              v-for="(name, index) in assigned(id)"
              :key="name"
              draggable="true"
              class="flex items-center gap-1 rounded-md border border-default px-2 py-1 text-sm"
              @dragstart="dragging = { role: id, index }"
              @dragover.prevent
              @drop="drop(id, index)"
            >
              <UIcon
                name="i-lucide-grip-vertical"
                class="size-4 shrink-0 cursor-grab text-dimmed"
              />
              <span class="min-w-0 flex-1 truncate">{{ name }}</span>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="t('dashboards.inspector.removeColumn', { column: name })"
                @click="setRole(id, assigned(id).filter(n => n !== name))"
              />
            </div>
            <USelectMenu
              :model-value="undefined"
              :items="roleItems(id, role).filter(i => !assigned(id).includes(i.value))"
              value-key="value"
              :placeholder="t('dashboards.inspector.addColumn')"
              :aria-label="catalog.roleLabel(type, id)"
              :disabled="!ran"
              class="w-full"
              @update:model-value="(v: string) => setRole(id, [...assigned(id), v])"
            />
          </div>
          <div
            v-else
            class="flex gap-1"
          >
            <USelectMenu
              :model-value="assigned(id)[0]"
              :items="roleItems(id, role)"
              value-key="value"
              :aria-label="catalog.roleLabel(type, id)"
              :disabled="!ran"
              class="min-w-0 flex-1"
              @update:model-value="(v: string) => setRole(id, v)"
            />
            <UTooltip
              v-if="assigned(id).length"
              :text="t('dashboards.inspector.useAutomatic')"
            >
              <UButton
                icon="i-lucide-ban"
                color="neutral"
                variant="ghost"
                :aria-label="t('dashboards.inspector.useAutomatic')"
                @click="setRole(id, undefined)"
              />
            </UTooltip>
          </div>
        </UFormField>
      </template>

      <template
        v-for="section in sections"
        :key="section"
      >
        <USeparator :label="t(`dashboards.inspector.sections.${section}`)" />
        <p
          v-if="section === 'format' && inheritedFormat"
          class="flex flex-wrap items-center gap-x-1 text-xs text-muted"
        >
          {{ t('dashboards.inspector.inheritedFormat', { format: inheritedFormat, column: valueColumn!.name }) }}
          <template v-if="valueColumn?.origin?.resourceId">
            ·
            <UButton
              :label="t('dashboards.inspector.editInTable')"
              variant="link"
              size="xs"
              class="p-0"
              @click="editingColumn = true"
            />
          </template>
        </p>
        <template
          v-for="[key, prop] in propsOf(section)"
          :key="key"
        >
          <!-- A color: unset is its default (a waterfall's green and red), else none - the theme's primary. -->
          <div
            v-if="prop.editor === 'color'"
            class="flex items-end gap-1"
          >
            <ColorPickerField
              :model-value="colorValue(key, prop)"
              :label="catalog.propLabel(type, key)"
              :allow-none="prop.default === undefined"
              @update:model-value="(v?: RoleColor) => setProp(key, v === prop.default ? undefined : v)"
            />
            <UTooltip
              v-if="prop.default !== undefined && config[key] !== undefined"
              :text="t('dashboards.inspector.useDefault')"
            >
              <UButton
                icon="i-lucide-ban"
                color="neutral"
                variant="ghost"
                :aria-label="t('dashboards.inspector.useDefault')"
                @click="setProp(key, undefined)"
              />
            </UTooltip>
          </div>
          <USwitch
            v-else-if="prop.editor === 'boolean'"
            :model-value="typeof config[key] === 'boolean' ? config[key] === true : prop.default === true"
            :label="catalog.propLabel(type, key)"
            :description="catalog.propDescription(type, key)"
            @update:model-value="(v: boolean) => setProp(key, v === prop.default ? undefined : v)"
          />
          <!-- One format for its numbers (D4): unset, its value column's - shown as the hint. -->
          <DisplayFormatField
            v-else-if="prop.editor === 'format'"
            :model-value="(config[key] as string | undefined)"
            kind="number"
            :description="inheritedFormat ? t('dashboards.inspector.unsetFormat', { format: inheritedFormat }) : catalog.propDescription(type, key)"
            @update:model-value="(v?: string) => setProp(key, v)"
          />
          <!-- The structured props (D4, D5, D6, D28): each its own editor. -->
          <UFormField
            v-else-if="STRUCTURED.includes(prop.editor)"
            :label="['series', 'axes', 'click'].includes(prop.editor) ? undefined : catalog.propLabel(type, key)"
            :required="prop.editor === 'aggregates'"
            :description="catalog.propDescription(type, key)"
          >
            <TableColumnsEditor
              v-if="prop.editor === 'tableColumns'"
              :model-value="(config[key] as Record<string, TableColumnSettings> | undefined)"
              :columns="columns"
              :excluded="tableExcluded"
              :totals="type === 'TABLE'"
              @update:model-value="(v?: Record<string, TableColumnSettings>) => setProp(key, v)"
            />
            <DashboardSeriesEditor
              v-else-if="prop.editor === 'series'"
              :model-value="(config[key] as Record<string, never> | undefined)"
              :series="seriesList"
              :default-type="chartMark"
              :addable="!!seriesColumn && !rows"
              :format-fallback="ownFormat ?? inheritedFormat"
              :defaults="seriesDefaults"
              :color-only="type === 'SCATTER'"
              @update:model-value="(v?: unknown) => setProp(key, v)"
            />
            <DashboardAxesEditor
              v-else-if="prop.editor === 'axes'"
              :model-value="(config[key] as Record<string, never> | undefined)"
              :show-value2="usesRightAxis"
              :min-unset="type === 'LINE' || type === 'SCATTER' ? 'fit' : 'zero'"
              :xy="type === 'SCATTER'"
              :format-fallback="type === 'SCATTER' ? roleFormat('x') ?? ownFormat : axisFormat('left')"
              :value2-format-fallback="type === 'SCATTER' ? roleFormat('y') ?? ownFormat : axisFormat('right')"
              @update:model-value="(v?: unknown) => setProp(key, v)"
            />
            <DashboardThresholdsEditor
              v-else-if="prop.editor === 'thresholds'"
              :model-value="(config[key] as never[] | undefined)"
              :columns="numberColumns"
              :variables="sourceVariables"
              @update:model-value="(v?: unknown[]) => setProp(key, v)"
            />
            <DashboardReferencesEditor
              v-else-if="prop.editor === 'references'"
              :model-value="(config[key] as never[] | undefined)"
              :columns="numberColumns"
              :variables="sourceVariables"
              :series="seriesList.map(s => ({ value: s.name, label: s.label }))"
              :axis-choice="type === 'SCATTER'"
              @update:model-value="(v?: unknown[]) => setProp(key, v)"
            />
            <DashboardAggregatesEditor
              v-else-if="prop.editor === 'aggregates'"
              :model-value="(config[key] as Record<string, never> | undefined)"
              :values="pivotValues"
              @update:model-value="(v?: unknown) => setProp(key, v)"
            />
            <DashboardPivotSortEditor
              v-else-if="prop.editor === 'pivotSort'"
              :model-value="(config[key] as never | undefined)"
              :values="pivotValues"
              @update:model-value="(v?: unknown) => setProp(key, v)"
            />
            <DashboardClickEditor
              v-else
              :model-value="(config[key] as never | undefined)"
              :columns="columns.map(c => c.name)"
              :variables="dashboardVariables"
              @update:model-value="(v?: unknown) => setProp(key, v)"
            />
          </UFormField>
          <UFormField
            v-else
            :label="catalog.propLabel(type, key)"
            :description="catalog.propDescription(type, key)"
          >
            <div class="flex gap-1">
              <UInputNumber
                v-if="prop.editor === 'number'"
                :model-value="numberValue(key, prop)"
                class="min-w-0 flex-1"
                @update:model-value="(v?: number | null) => setProp(key, v === prop.default ? undefined : v)"
              />
              <USelectMenu
                v-else-if="prop.editor === 'column'"
                :model-value="(config[key] as string | undefined)"
                :items="columnItems"
                value-key="value"
                :aria-label="catalog.propLabel(type, key)"
                :disabled="!ran"
                class="min-w-0 flex-1"
                @update:model-value="(v: string) => setProp(key, v)"
              />
              <USelect
                v-else-if="prop.editor === 'select'"
                :model-value="textValue(key, prop)"
                :items="optionItems(key, prop)"
                :aria-label="catalog.propLabel(type, key)"
                class="min-w-0 flex-1"
                @update:model-value="(v: string) => setProp(key, v === prop.default ? undefined : v)"
              />
              <UInput
                v-else
                :model-value="(config[key] as string | undefined) ?? ''"
                class="min-w-0 flex-1"
                @update:model-value="(v: string | number) => setProp(key, String(v))"
              />
              <UTooltip
                v-if="config[key] !== undefined"
                :text="t('dashboards.inspector.useDefault')"
              >
                <UButton
                  icon="i-lucide-ban"
                  color="neutral"
                  variant="ghost"
                  :aria-label="t('dashboards.inspector.useDefault')"
                  @click="setProp(key, undefined)"
                />
              </UTooltip>
            </div>
          </UFormField>
        </template>
      </template>

      <!-- What every card takes (D23): its ⓘ, what it says with no rows, and how it sits on a phone. -->
      <USeparator :label="t('dashboards.inspector.card.section')" />
      <UFormField
        :label="t('dashboards.inspector.card.description')"
        :description="t('dashboards.inspector.card.descriptionHelp')"
      >
        <UTextarea
          :model-value="String(config.description ?? '')"
          :rows="2"
          autoresize
          :maxlength="200"
          class="w-full"
          @update:model-value="(v: string) => setProp('description', v)"
        />
      </UFormField>
      <UFormField
        v-if="!page"
        :label="t('dashboards.inspector.card.emptyText')"
        :description="t('dashboards.inspector.card.emptyTextHelp')"
      >
        <UInput
          :model-value="String(config.emptyText ?? '')"
          :maxlength="200"
          class="w-full"
          @update:model-value="(v: string | number) => setProp('emptyText', String(v))"
        />
      </UFormField>
      <UFormField
        :label="t('dashboards.inspector.card.mobile')"
        :description="t('dashboards.inspector.card.mobileHelp')"
      >
        <USelect
          :model-value="String(config.mobile ?? 'AUTO')"
          :items="mobileItems"
          class="w-full"
          @update:model-value="(v: string) => setProp('mobile', v === 'AUTO' ? undefined : v)"
        />
      </UFormField>
    </template>

    <WidgetStyleFields
      v-else
      :values="style"
      :applied="styleCount"
      no-row-align
      @set="setStyle"
      @reset="setProp('style', undefined)"
    />
    <ColumnPresentationEditor
      v-if="editingColumn && valueColumn?.origin?.resourceId"
      v-model:open="editingColumn"
      :resource-id="valueColumn.origin.resourceId"
      :column-name="valueColumn.origin.column"
    />
  </div>
</template>
