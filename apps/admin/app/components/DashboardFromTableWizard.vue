<script setup lang="ts">
/**
 * New dashboard › From a table (Specification_Dashboards.md §10.7, D27): the
 * dashboard assistant on the product's WizardModal (AGENTS.md section 25).
 * 1) the table or view - choosing it analyzes it (`POST /dashboards/suggest`,
 * the service MCP's suggest_dashboard calls: the catalog and pg_stats, never
 * its rows); 2) each column's role and why, what's missing, and Analyze again
 * (after adding a CHECK or a foreign key); 3) a checkbox per proposed widget
 * (the proposal's ticked, `more`'s not), the variables, the security options
 * (off, one at most - choosing one switches to its proposal, keeping the
 * user's ticks) and the name; 4) a summary, and Create - the chosen spec
 * through `POST /dashboards/spec` (apply_dashboard's service), every problem
 * listed by its path. What it creates is an ordinary draft: its SQL visible
 * and editable, no link back to the assistant.
 */
import type { TableColumn } from '@nuxt/ui'
import { DASHBOARD_WIDGET_TYPES, type DashboardWidgetType } from '@totalbase/tb-catalog'
import type { WizardStep } from '~/components/WizardModal.vue'
import type { AdminApiError as ApiErrorShape } from '~/types/api'
import { DASHBOARD_VARIABLE_TYPES, useDashboardCatalogText, type DashboardVariableType } from '~/types/dashboard'
import { AdminApiError } from '~/utils/admin-api-error'
import { useApiErrorMessage, useApiErrorText } from '~/utils/api-error-message'
import {
  buildFinalSpec, carryTicks, defaultTicks, widgetChoices, widgetIdentity, widgetReasons,
  type DashboardApplyResult, type DashboardSuggestion, type SuggestBase, type SuggestColumnAnalysis, type SuggestColumnRole, type SuggestSecurityOption
} from '~/utils/dashboard-from-table'

const open = defineModel<boolean>('open', { default: false })
/** Opened from a table's or view's page: that one chosen - analyzed at once (Create Dashboard). */
const props = defineProps<{ initialResourceId?: string }>()
const emit = defineEmits<{ created: [id: string] }>()

const NAME_MAX = 32
const F = 'dashboards.fromTable'

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const errorText = useApiErrorText()
const catalogText = useDashboardCatalogText()
const { resources } = useResourcesList()

// --- Step 1: the table or view ---
const sourceOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && (r.type === 'TABLE' || r.type === 'VIEW'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id, schema: r.schema, name: r.name, icon: r.type === 'VIEW' ? 'i-lucide-eye' : 'i-lucide-table' }))
    .sort((a, b) => a.label.localeCompare(b.label))
)
const resourceId = ref<string | undefined>(undefined)
const selected = computed(() => sourceOptions.value.find(o => o.value === resourceId.value))

const suggestion = ref<DashboardSuggestion | null>(null)
/** The resource the current suggestion is for - a new choice drops it until it's analyzed. */
const analyzedId = ref<string | null>(null)
const analyzing = ref(false)
const analyzeError = ref<string | null>(null)

// --- Step 3: the review ---
const optionKey = ref<string | null>(null)
const ticks = ref(new Set<string>())
const name = ref('')
const nameTouched = ref(false)

// --- Step 4: the problems the server found ---
const specErrors = ref<ApiErrorShape[]>([])
const creating = ref(false)

function reset() {
  resourceId.value = props.initialResourceId
  suggestion.value = null
  analyzedId.value = null
  analyzeError.value = null
  optionKey.value = null
  ticks.value = new Set()
  name.value = ''
  nameTouched.value = false
  specErrors.value = []
}
// Immediate: mounted on its first open (useOpenedOnce), it is already open then.
watch(open, (value) => {
  if (value) reset()
}, { immediate: true })

const optionId = (option: SuggestSecurityOption) => `${option.key}:${option.column}`
const chosenOption = computed(() => suggestion.value?.security.options.find(o => optionId(o) === optionKey.value) ?? null)
/** The proposal being reviewed: the suggestion's, or the chosen security option's. */
const base = computed<SuggestBase | null>(() => chosenOption.value ?? suggestion.value)

/** Analyzes the chosen table - again, after a change to it, keeping the user's ticks and name. */
async function analyze() {
  const source = selected.value
  if (!source) return
  analyzing.value = true
  analyzeError.value = null
  try {
    const { data } = await api.post<DashboardSuggestion>('/dashboards/suggest', { data: { name: source.name, schema: source.schema } })
    if (resourceId.value !== source.value) return
    const again = analyzedId.value === source.value && base.value
    const previous = again ? { base: base.value!, ticks: ticks.value } : null
    suggestion.value = data
    analyzedId.value = source.value
    if (!data.security.options.some(o => optionId(o) === optionKey.value)) optionKey.value = null
    ticks.value = previous ? carryTicks(previous.base, previous.ticks, base.value!) : defaultTicks(data)
    if (!nameTouched.value) name.value = data.spec.name.slice(0, NAME_MAX)
    specErrors.value = []
  } catch (error) {
    if (resourceId.value === source.value) analyzeError.value = errorMessage(error, t(`${F}.analyzeFailed`))
  } finally {
    analyzing.value = false
  }
}
// By the chosen source as the list knows it: a table preset before the list loads is analyzed once it's there.
watch(() => selected.value?.value, (id) => {
  if (!id) {
    suggestion.value = null
    analyzedId.value = null
    return
  }
  if (id === analyzedId.value) return
  optionKey.value = null
  nameTouched.value = false
  void analyze()
})

// --- Step 2: the analysis ---
const ROLE_COLOR: Record<SuggestColumnRole, 'primary' | 'info' | 'success' | 'neutral'> = {
  moment: 'info',
  deadline: 'info',
  measure: 'success',
  category: 'primary',
  dimension: 'primary',
  identifier: 'neutral',
  place: 'neutral',
  file: 'neutral',
  discarded: 'neutral'
}
/** A phone has no room for three columns: the role goes under the column's name. */
const isMobile = useIsMobile()
const analysisColumns = computed<TableColumn<SuggestColumnAnalysis>[]>(() => [
  { accessorKey: 'column', header: t(`${F}.column`), meta: { class: { th: isMobile.value ? 'w-32' : 'w-48', td: isMobile.value ? 'w-32 align-top' : 'w-48 align-top' } } },
  ...(isMobile.value ? [] : [{ accessorKey: 'role', header: t(`${F}.role`), meta: { class: { th: 'w-36', td: 'w-36 align-top' } } }]),
  { id: 'reason', header: t(`${F}.reason`), meta: { class: { td: 'whitespace-normal align-top' } } }
])

// --- Step 3: the review ---
const reasons = computed(() => (suggestion.value ? widgetReasons(suggestion.value) : new Map()))
const choices = computed(() => (base.value ? widgetChoices(base.value) : []))
const widgetLabel = (type: string) => ((DASHBOARD_WIDGET_TYPES as readonly string[]).includes(type) ? catalogText.widgetLabel(type as DashboardWidgetType) : type)

function toggleWidget(key: string, value: boolean | 'indeterminate') {
  const next = new Set(ticks.value)
  if (value === true) next.add(key)
  else next.delete(key)
  ticks.value = next
}
/** A security option on or off - at most one, its proposal replacing the base one with the user's ticks kept. */
function toggleOption(option: SuggestSecurityOption, value: boolean | 'indeterminate') {
  const from = base.value
  optionKey.value = value === true ? optionId(option) : null
  if (from && base.value) ticks.value = carryTicks(from, ticks.value, base.value)
}
const nameError = computed(() => {
  const trimmed = name.value.trim()
  if (!trimmed) return t(`${F}.nameRequired`)
  if (trimmed.length > NAME_MAX) return t(`${F}.nameTooLong`, { max: NAME_MAX })
  return null
})
const variables = computed(() => base.value?.spec.variables ?? [])
function variableTypeLabel(type: DashboardVariableType): string {
  const entry = DASHBOARD_VARIABLE_TYPES.find(v => v.value === type)
  return entry ? catalogText.variableTypeLabel(entry) : type
}
const finalSpec = computed(() => (base.value ? buildFinalSpec(base.value, ticks.value, name.value) : null))
// A problem the server found is about the spec as sent - a change to it makes it stale.
watch(finalSpec, () => {
  specErrors.value = []
})

// --- Step 4: create ---
/** A problem's place in words: a widget's by its title, else the path as the server gave it. */
function errorPlace(path: string | undefined): string | null {
  if (!path) return null
  const match = /^widgets\[(\d+)\]/.exec(path)
  const widget = match ? finalSpec.value?.widgets[Number(match[1])] : undefined
  return widget ? `${widget.label || widgetLabel(widget.type)} · ${path}` : path
}

async function create() {
  const spec = finalSpec.value
  if (!spec) return
  creating.value = true
  specErrors.value = []
  try {
    const { data } = await api.post<DashboardApplyResult>('/dashboards/spec', { data: { spec } })
    open.value = false
    toast.add({ title: t(`${F}.created`, { name: spec.name }), color: 'success' })
    emit('created', data.id)
  } catch (error) {
    if (error instanceof AdminApiError && (error.status === 422 || error.status === 409)) specErrors.value = error.allErrors
    else toast.add({ title: errorMessage(error, t(`${F}.createFailed`)), color: 'error' })
  } finally {
    creating.value = false
  }
}

const steps = computed<WizardStep[]>(() => [
  { key: 'source', title: t(`${F}.steps.source.title`), description: t(`${F}.steps.source.description`), valid: Boolean(suggestion.value) && analyzedId.value === resourceId.value && !analyzing.value },
  { key: 'analysis', title: t(`${F}.steps.analysis.title`), description: t(`${F}.steps.analysis.description`), valid: !analyzing.value && Boolean(suggestion.value) },
  { key: 'review', title: t(`${F}.steps.review.title`), description: t(`${F}.steps.review.description`), valid: !nameError.value && ticks.value.size > 0 },
  { key: 'generate', title: t(`${F}.steps.generate.title`), description: t(`${F}.steps.generate.description`), valid: Boolean(finalSpec.value?.widgets.length) && !nameError.value }
])
</script>

<template>
  <WizardModal
    v-model:open="open"
    :title="t(`${F}.title`)"
    :description="t(`${F}.description`)"
    :steps="steps"
    :submit-label="t(`${F}.submit`)"
    :submitting="creating"
    width="max-w-5xl"
    height="h-[62vh]"
    @submit="create"
  >
    <template #source>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t(`${F}.tableOrView`)"
          :description="t(`${F}.tableOrViewHelp`)"
        >
          <USelectMenu
            v-model="resourceId"
            :items="sourceOptions"
            value-key="value"
            :loading="analyzing"
            class="w-full"
          />
        </UFormField>
        <UEmpty
          v-if="analyzing"
          loading
          variant="naked"
          size="sm"
          :title="t(`${F}.analyzing`)"
        />
        <UAlert
          v-else-if="analyzeError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="analyzeError"
          :actions="[{ label: t(`${F}.analyzeAgain`), color: 'error', variant: 'outline', onClick: analyze }]"
        />
        <p
          v-else-if="suggestion && analyzedId === resourceId"
          class="text-sm text-muted"
        >
          {{ t(`${F}.analyzed`, { columns: suggestion.analysis.length, widgets: suggestion.spec.widgets.length }) }}
        </p>
      </div>
    </template>

    <template #analysis>
      <div
        v-if="suggestion"
        class="flex flex-col gap-4"
      >
        <div class="flex items-center justify-between gap-3">
          <p class="min-w-0 text-sm text-muted">
            <span class="font-mono text-highlighted">{{ suggestion.relation.schema }}.{{ suggestion.relation.name }}</span>
            · {{ t(`${F}.columnsCount`, { n: suggestion.analysis.length }, suggestion.analysis.length) }}
          </p>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            :label="t(`${F}.analyzeAgain`)"
            :loading="analyzing"
            class="shrink-0"
            @click="analyze"
          />
        </div>
        <div
          v-if="suggestion.missing.length"
          class="flex flex-col gap-2"
        >
          <UAlert
            v-for="(item, i) in suggestion.missing"
            :key="`${item.code}-${i}`"
            color="warning"
            variant="subtle"
            icon="i-lucide-lightbulb"
            :title="item.message"
          />
        </div>
        <UTable
          sticky
          :data="suggestion.analysis"
          :columns="analysisColumns"
        >
          <template #column-cell="{ row: { original: col } }">
            <span class="block font-mono text-sm text-highlighted">{{ col.column }}</span>
            <span
              v-if="col.origin"
              class="block font-mono text-xs text-muted"
            >{{ col.origin }}</span>
            <div
              v-if="isMobile"
              class="mt-1"
            >
              <UBadge
                :label="t(`${F}.roles.${col.role}`)"
                :color="ROLE_COLOR[col.role]"
                :variant="col.role === 'discarded' || col.role === 'identifier' ? 'outline' : 'subtle'"
              />
            </div>
          </template>
          <template #role-cell="{ row: { original: col } }">
            <UBadge
              :label="t(`${F}.roles.${col.role}`)"
              :color="ROLE_COLOR[col.role]"
              :variant="col.role === 'discarded' || col.role === 'identifier' ? 'outline' : 'subtle'"
            />
          </template>
          <template #reason-cell="{ row: { original: col } }">
            <p class="text-sm">
              {{ col.reason.message }}
            </p>
            <p
              v-if="col.reason.detail"
              class="text-xs text-muted"
            >
              {{ col.reason.detail }}
            </p>
            <p
              v-if="col.alternatives?.length"
              class="text-xs text-muted"
            >
              {{ t(`${F}.alternatives`, { columns: col.alternatives.join(', ') }) }}
            </p>
          </template>
        </UTable>
      </div>
    </template>

    <template #review>
      <div
        v-if="suggestion && base"
        class="flex flex-col gap-6"
      >
        <UFormField
          :label="t('common.name')"
          :description="t(`${F}.nameHelp`, { max: NAME_MAX })"
          :error="nameError ?? undefined"
          required
        >
          <UInput
            v-model="name"
            :maxlength="NAME_MAX"
            class="w-full md:w-96"
            @update:model-value="nameTouched = true"
          />
        </UFormField>

        <section class="flex flex-col gap-3">
          <div>
            <h3 class="text-sm font-medium text-highlighted">
              {{ t(`${F}.widgets`) }}
            </h3>
            <p class="text-xs text-muted">
              {{ t(`${F}.widgetsHelp`) }}
            </p>
          </div>
          <div class="flex flex-col divide-y divide-default rounded-md border border-default">
            <div
              v-for="choice in choices"
              :key="choice.key"
              class="px-3 py-2.5"
            >
              <UCheckbox
                :model-value="ticks.has(choice.key)"
                :label="choice.widget.label || widgetLabel(choice.widget.type)"
                :description="[widgetLabel(choice.widget.type), reasons.get(widgetIdentity(choice.widget))?.message].filter(Boolean).join(' · ')"
                @update:model-value="toggleWidget(choice.key, $event)"
              />
            </div>
          </div>
        </section>

        <section
          v-if="variables.length"
          class="flex flex-col gap-2"
        >
          <div>
            <h3 class="text-sm font-medium text-highlighted">
              {{ t(`${F}.variables`) }}
            </h3>
            <p class="text-xs text-muted">
              {{ t(`${F}.variablesHelp`) }}
            </p>
          </div>
          <ul class="flex flex-col gap-1 text-sm">
            <li
              v-for="variable in variables"
              :key="variable.name"
              class="flex flex-wrap items-baseline gap-x-2"
            >
              <span class="text-highlighted">{{ variable.label }}</span>
              <span class="font-mono text-xs text-muted">$VAR.{{ variable.name }}</span>
              <span class="text-xs text-muted">{{ variableTypeLabel(variable.type) }}</span>
            </li>
          </ul>
        </section>

        <section class="flex flex-col gap-3">
          <h3 class="text-sm font-medium text-highlighted">
            {{ t(`${F}.security`) }}
          </h3>
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-shield"
            :title="suggestion.security.notice.message"
          />
          <UCheckbox
            v-for="option in suggestion.security.options"
            :key="optionId(option)"
            :model-value="optionKey === optionId(option)"
            :label="t(`${F}.securityOptions.${option.key}`, { column: option.column })"
            :description="option.reason.message"
            @update:model-value="toggleOption(option, $event)"
          />
        </section>
      </div>
    </template>

    <template #generate>
      <div
        v-if="finalSpec"
        class="flex flex-col gap-4"
      >
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt class="text-muted">
            {{ t('common.name') }}
          </dt>
          <dd class="text-highlighted">
            {{ finalSpec.name }}
          </dd>
          <dt class="text-muted">
            {{ t(`${F}.source`) }}
          </dt>
          <dd class="font-mono">
            {{ suggestion?.relation.schema }}.{{ suggestion?.relation.name }}
          </dd>
          <dt class="text-muted">
            {{ t(`${F}.widgets`) }}
          </dt>
          <dd>{{ t(`${F}.widgetsCount`, { n: finalSpec.widgets.length }, finalSpec.widgets.length) }}</dd>
          <dt class="text-muted">
            {{ t(`${F}.variables`) }}
          </dt>
          <dd>{{ t(`${F}.variablesCount`, { n: finalSpec.variables?.length ?? 0 }, finalSpec.variables?.length ?? 0) }}</dd>
          <dt class="text-muted">
            {{ t(`${F}.security`) }}
          </dt>
          <dd>{{ chosenOption ? t(`${F}.securityOptions.${chosenOption.key}`, { column: chosenOption.column }) : t(`${F}.securityAllRows`) }}</dd>
        </dl>
        <p class="text-sm text-muted">
          {{ t(`${F}.generateHelp`) }}
        </p>
        <UAlert
          v-if="specErrors.length"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t(`${F}.specInvalid`, { n: specErrors.length }, specErrors.length)"
        >
          <template #description>
            <ul class="mt-1 flex flex-col gap-1.5">
              <li
                v-for="(error, i) in specErrors"
                :key="i"
              >
                <span
                  v-if="errorPlace(error.path)"
                  class="block font-mono text-xs"
                >{{ errorPlace(error.path) }}</span>
                {{ errorText(error) }}
              </li>
            </ul>
          </template>
        </UAlert>
      </div>
    </template>
  </WizardModal>
</template>
