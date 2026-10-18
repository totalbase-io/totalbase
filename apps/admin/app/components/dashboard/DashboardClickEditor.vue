<script setup lang="ts">
/**
 * What a click on a widget's mark does (D6, `config.click`): one action - filter this dashboard by a variable, open a
 * DataView filtered, another dashboard (its tab, its variables), a record, or a URL - with its values as formulas over
 * the clicked row (`{{row.<column>}}`) and the variables (`{{vars.<name>}}`), its targets by id, and the tooltip's last
 * line (`hint`). A line says where it works: FILTER and a URL marked for embeds also run in embeds, the rest only in
 * the App. The server checks every reference on save; its refusal shows as the drawer's error.
 */
import type { DataView } from '~/types/dataview'
import type { Dashboard, DashboardVariable } from '~/types/dashboard'

type Action = 'FILTER' | 'DATAVIEW' | 'DASHBOARD' | 'RECORD' | 'URL'
type Click = { action: Action, hint?: string } & Record<string, unknown>
interface DashboardTab { value: string, label: string, icon?: string }

const props = defineProps<{
  /** The query's result columns, by name - what `{{row.<column>}}` reads. */
  columns: string[]
  /** This dashboard's variables - FILTER's targets and `{{vars.<name>}}`. */
  variables: { value: string, label: string, type: string }[]
}>()
const model = defineModel<Click | undefined>()
const { t } = useI18n()
const api = useAdminApi()

const NONE = 'NONE'
const ACTIONS: Action[] = ['FILTER', 'DATAVIEW', 'DASHBOARD', 'RECORD', 'URL']
const action = computed(() => model.value?.action)
const actionItems = computed(() => [NONE, ...ACTIONS].map(value => ({ value, label: t(`dashboards.inspector.click.actions.${value}`) })))
function setAction(next: string) {
  if (next === action.value) return
  const hint = model.value?.hint
  model.value = next === NONE ? undefined : { action: next as Action, ...(hint ? { hint } : {}) }
}
function set(key: string, value: unknown) {
  if (!model.value) return
  const empty = value === undefined || value === null || value === '' || value === false
  const { [key]: _old, ...rest } = model.value
  model.value = (empty ? rest : { ...rest, [key]: value }) as Click
}
const text = (key: string) => (typeof model.value?.[key] === 'string' ? model.value[key] as string : '')

/** In an embed only FILTER (on a variable the visitor may change) and a URL marked for embeds run. */
const worksInEmbeds = computed(() => action.value === 'FILTER' || (action.value === 'URL' && model.value?.inEmbeds === true))

// --- Formulas: what they read -------------------------------------------------------------

const formulaHelp = computed(() => t('dashboards.inspector.click.formulaHelp', {
  row: '{{row.<column>}}',
  columns: props.columns.length ? props.columns.join(', ') : t('dashboards.inspector.runToListColumns'),
  vars: '{{vars.<name>}}',
  variables: props.variables.length ? props.variables.map(v => v.value).join(', ') : t('common.none')
}))

// --- FILTER: a SELECT, TEXT or NUMBER variable of this dashboard -------------------------

const filterVariables = computed(() => props.variables
  .filter(v => ['SELECT', 'TEXT', 'NUMBER'].includes(v.type))
  .map(v => ({ value: v.value, label: v.label, description: `$VAR.${v.value}` })))

// --- DATAVIEW, RECORD: a DataView; DASHBOARD: a dashboard - read once, when one is needed ---

const dataviews = ref<DataView[] | null>(null)
const dashboards = ref<Dashboard[] | null>(null)
watch(action, async (next) => {
  try {
    if ((next === 'DATAVIEW' || next === 'RECORD') && !dataviews.value) dataviews.value = (await api.get<DataView[]>('/dataviews')).data
    if (next === 'DASHBOARD' && !dashboards.value) dashboards.value = (await api.get<Dashboard[]>('/dashboards')).data
  } catch {
    // Best-effort: an empty picker; the server still checks the id on save.
  }
}, { immediate: true })
const dataviewItems = computed(() => (dataviews.value ?? []).map(d => ({
  value: d.id,
  label: d.name,
  description: d.description ?? (d.sourceResourceName ? `${d.sourceResourceSchema}.${d.sourceResourceName}` : undefined)
})))
const dashboardItems = computed(() => (dashboards.value ?? []).map(d => ({ value: d.id, label: d.name, description: d.description ?? undefined })))

/** The target dashboard's tabs and variables - read when it's chosen. */
const target = ref<{ tabs: DashboardTab[], variables: DashboardVariable[] }>({ tabs: [], variables: [] })
watch(() => (action.value === 'DASHBOARD' ? text('dashboard') : ''), async (id) => {
  target.value = { tabs: [], variables: [] }
  if (!id) return
  try {
    const { data } = await api.get<Dashboard & { tabs?: DashboardTab[] }>(`/dashboards/${id}`)
    target.value = { tabs: data.tabs ?? [], variables: data.variables ?? [] }
  } catch {
    // Best-effort: no tab or variables to offer.
  }
}, { immediate: true })
const FIRST_TAB = '__first__'
const tabItems = computed(() => [{ value: FIRST_TAB, label: t('dashboards.inspector.click.firstTab') }, ...target.value.tabs.map(tab => ({ value: tab.value, label: tab.label, icon: tab.icon }))])
const targetVariables = computed<Record<string, string>>(() => {
  const value = model.value?.variables
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {}
})
function setTargetVariable(name: string, formula: string) {
  const { [name]: _old, ...rest } = targetVariables.value
  const next = formula.trim() ? { ...rest, [name]: formula } : rest
  set('variables', Object.keys(next).length ? next : undefined)
}

// --- DATAVIEW's filter: a JSON object in the `where` grammar, kept as typed until it parses ---

const filterText = ref('')
const filterError = ref<string | undefined>()
watch(() => model.value?.filter, (filter) => {
  try {
    if (filterText.value.trim() && JSON.stringify(JSON.parse(filterText.value)) === JSON.stringify(filter ?? null)) return
  } catch {
    // What's typed doesn't parse yet - it stays until it does.
    return
  }
  filterText.value = filter === undefined ? '' : JSON.stringify(filter, null, 2)
}, { immediate: true })
function setFilter(value: string) {
  filterText.value = value
  if (!value.trim()) {
    filterError.value = undefined
    set('filter', undefined)
    return
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    filterError.value = undefined
    set('filter', parsed)
  } catch {
    filterError.value = t('dashboards.inspector.click.filterInvalid')
  }
}
const filterExample = '{"column": {"_eq": "{{row.x}}"}}'
</script>

<template>
  <div class="flex flex-col gap-3">
    <UFormField :label="t('dashboards.inspector.click.action')">
      <USelect
        :model-value="action ?? NONE"
        :items="actionItems"
        class="w-full"
        @update:model-value="(v: string) => setAction(v)"
      />
    </UFormField>

    <template v-if="action">
      <p class="flex items-center gap-1 text-xs text-muted">
        <UIcon
          :name="worksInEmbeds ? 'i-lucide-globe' : 'i-lucide-app-window'"
          class="size-3.5 shrink-0"
        />
        {{ worksInEmbeds ? t('dashboards.inspector.click.worksIn.embeds') : t('dashboards.inspector.click.worksIn.app') }}
      </p>

      <!-- FILTER: a variable of this dashboard, set to a formula's value. -->
      <template v-if="action === 'FILTER'">
        <UFormField
          :label="t('dashboards.inspector.click.variable')"
          :description="filterVariables.length ? t('dashboards.inspector.click.variableHelp') : t('dashboards.inspector.click.noFilterVariables')"
          required
        >
          <USelectMenu
            :model-value="text('variable') || undefined"
            :items="filterVariables"
            value-key="value"
            class="w-full"
            @update:model-value="(v: string) => set('variable', v)"
          />
        </UFormField>
        <UFormField
          :label="t('common.value')"
          :description="formulaHelp"
          required
        >
          <UInput
            :model-value="text('value')"
            class="w-full font-mono"
            @update:model-value="(v: string | number) => set('value', String(v))"
          />
        </UFormField>
      </template>

      <!-- DATAVIEW, RECORD: a DataView - filtered, or one of its records. -->
      <template v-if="action === 'DATAVIEW' || action === 'RECORD'">
        <UFormField
          :label="t('dashboards.inspector.click.dataview')"
          required
        >
          <USelectMenu
            :model-value="text('dataview') || undefined"
            :items="dataviewItems"
            value-key="value"
            :loading="dataviews === null"
            class="w-full"
            @update:model-value="(v: string) => set('dataview', v)"
          >
            <template #item-label="{ item }">
              <span class="font-semibold">{{ item.label }}</span>
            </template>
          </USelectMenu>
        </UFormField>
        <UFormField
          v-if="action === 'DATAVIEW'"
          :label="t('dashboards.inspector.click.filter')"
          :description="t('dashboards.inspector.click.filterHelp', { example: filterExample })"
          :error="filterError"
        >
          <UTextarea
            :model-value="filterText"
            :rows="3"
            autoresize
            class="w-full font-mono"
            @update:model-value="(v: string) => setFilter(v)"
          />
        </UFormField>
        <UFormField
          v-else
          :label="t('dashboards.inspector.click.pk')"
          :description="formulaHelp"
          required
        >
          <UInput
            :model-value="text('pk')"
            class="w-full font-mono"
            @update:model-value="(v: string | number) => set('pk', String(v))"
          />
        </UFormField>
      </template>

      <!-- DASHBOARD: another dashboard, its tab, its variables from formulas. -->
      <template v-if="action === 'DASHBOARD'">
        <UFormField
          :label="t('dashboards.inspector.click.dashboard')"
          required
        >
          <USelectMenu
            :model-value="text('dashboard') || undefined"
            :items="dashboardItems"
            value-key="value"
            :loading="dashboards === null"
            class="w-full"
            @update:model-value="(v: string) => set('dashboard', v)"
          >
            <template #item-label="{ item }">
              <span class="font-semibold">{{ item.label }}</span>
            </template>
          </USelectMenu>
        </UFormField>
        <template v-if="text('dashboard')">
          <UFormField
            v-if="target.tabs.length || text('tab')"
            :label="t('dashboards.inspector.click.tab')"
          >
            <USelect
              :model-value="text('tab') || FIRST_TAB"
              :items="tabItems"
              class="w-full"
              @update:model-value="(v: string) => set('tab', v === FIRST_TAB ? undefined : v)"
            />
          </UFormField>
          <UFormField
            :label="t('dashboards.inspector.click.variables')"
            :description="target.variables.length ? formulaHelp : t('dashboards.inspector.click.noTargetVariables')"
          >
            <div class="flex flex-col gap-1">
              <div
                v-for="variable in target.variables"
                :key="variable.name"
                class="flex items-center gap-2"
              >
                <span class="w-28 shrink-0 truncate text-sm text-muted">{{ variable.label || variable.name }}</span>
                <UInput
                  :model-value="targetVariables[variable.name] ?? ''"
                  :aria-label="variable.label || variable.name"
                  class="flex-1 font-mono"
                  @update:model-value="(v: string | number) => setTargetVariable(variable.name, String(v))"
                />
              </div>
            </div>
          </UFormField>
        </template>
      </template>

      <!-- URL: written out (its site), tokens after it. -->
      <template v-if="action === 'URL'">
        <UFormField
          :label="t('dashboards.inspector.click.url')"
          :description="t('dashboards.inspector.click.urlHelp', { row: '{{row.<column>}}', vars: '{{vars.<name>}}' })"
          required
        >
          <UInput
            :model-value="text('url')"
            class="w-full font-mono"
            @update:model-value="(v: string | number) => set('url', String(v))"
          />
        </UFormField>
        <USwitch
          :model-value="model?.newTab === true"
          :label="t('dashboards.inspector.click.newTab')"
          @update:model-value="(v: boolean) => set('newTab', v)"
        />
        <USwitch
          :model-value="model?.inEmbeds === true"
          :label="t('dashboards.inspector.click.inEmbeds')"
          :description="t('dashboards.inspector.click.inEmbedsHelp')"
          @update:model-value="(v: boolean) => set('inEmbeds', v)"
        />
      </template>

      <UFormField
        :label="t('dashboards.inspector.click.hint')"
        :description="t('dashboards.inspector.click.hintHelp')"
      >
        <UInput
          :model-value="text('hint')"
          :maxlength="100"
          class="w-full"
          @update:model-value="(v: string | number) => set('hint', String(v))"
        />
      </UFormField>
    </template>
  </div>
</template>
