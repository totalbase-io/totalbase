<script setup lang="ts">
/**
 * Trigger card picker + that trigger's own configuration fields, shared by
 * NewWorkflowModal.vue's creation wizard and EditWorkflowTriggerModal.vue's
 * edit wizard - both steps 2/3 of the AGENTS.md "Multi-step wizards" rail
 * (see NewWorkflowModal.vue's own doc comment for the full
 * Specification_Workflows.md §6 reasoning this component implements).
 *
 * `view` picks which half renders: 'cards' is step 2 (bare picker), 'config'
 * is step 3 (the selected kind's own fields). Splitting into one component
 * with two views (rather than two components) keeps the trigger kind and
 * its per-kind state in one place - the config view needs to react to a
 * kind chosen in the cards view an instant ago, in the same wizard.
 */
import { WORKFLOWS_SYSTEM_USER_EMAIL, type AdminUserListItem } from '~/types/security'
import { useTriggerOptions, type TriggerOption } from '~/utils/workflow-triggers'

const props = defineProps<{
  /** `cards`: the event picker; `config`: the chosen event's fields; `all`: both, the settings page. */
  view: 'cards' | 'config' | 'all'
  /** Existing Start `configuration` to seed from, for the edit wizard. Ignored once the fields are touched - see `parseInitial` below. */
  initial?: Record<string, unknown>
  /** The workflow being edited (the Settings wizard) - its CRON preview shows the last occurrence. */
  workflowId?: string
}>()
const kind = defineModel<TriggerOption['value'] | null>('kind', { default: null })
const emit = defineEmits<{ 'update:valid': [boolean], 'change': [] }>()

const api = useAdminApi()
const { t } = useI18n()
const triggerOptions = useTriggerOptions()

const { resources } = useResourcesList()
const tables = computed(() => resources.value.filter(resource => resource.type === 'TABLE' && resource.status === 'ACTIVE'))
const tableItems = computed(() => tables.value.map(table => ({ label: table.name, value: table.id })).sort((a, b) => a.label.localeCompare(b.label)))

// `executeAs` defaults to the seeded "Workflows" system account (migration
// 000074), not to whoever happens to be creating the workflow - a
// data-event run has an originating write (the "initiator", e.g. Pedro
// creating a product) but that is a traceability fact, not an
// authorization one: every operation the workflow itself performs runs
// as this configured account instead, the same "one fixed identity, no
// per-trigger permission re-check" shape CRON/WEBHOOK already require
// below. That account is ADMIN (full data access, by design - see the
// migration's own comment) and can_login = false (can never itself be used
// to sign in). Still editable, same as any other default - the "execute
// as" pickers (UserPicker, server-side search) list it like any other
// active user. Looked up by its fixed email, not by loading every user.
const { data: workflowsSystemUser } = useAsyncData(
  'workflow-system-user',
  () => api.get<AdminUserListItem[]>('/users', { q: WORKFLOWS_SYSTEM_USER_EMAIL, limit: 1 })
    .then(r => r.data.find(u => u.email === WORKFLOWS_SYSTEM_USER_EMAIL) ?? null)
)
const workflowsSystemUserId = computed(() => workflowsSystemUser.value?.id ?? null)
const dataEvent = ref({
  resource: null as string | null,
  events: [] as ('CREATE' | 'UPDATE' | 'DELETE')[],
  executeAs: null as string | null,
  // Specification_Workflows.md §6.3.1: one run per row, or one per write with the list of rows.
  forEach: 'ROW' as 'ROW' | 'STATEMENT',
  // The Start's own matching, the one filter grammar - JSON, empty for none.
  filterText: '',
  oldFilterText: '',
  changedFields: [] as string[]
})
// MANUAL Start options (Specification_Workflows.md §6.2): who it runs as, an input form, a confirmation.
type ManualFieldType = 'text' | 'number' | 'boolean' | 'date'
const manual = ref({
  executeAs: null as string | null,
  inputFields: [] as { name: string, label: string, type: ManualFieldType, required: boolean }[],
  confirmMessage: ''
})
const FIELD_TYPES = computed<{ label: string, value: ManualFieldType }[]>(() => [
  { label: t('workflows.triggerFields.fieldTypes.text'), value: 'text' },
  { label: t('workflows.triggerFields.fieldTypes.number'), value: 'number' },
  { label: t('workflows.triggerFields.fieldTypes.boolean'), value: 'boolean' },
  { label: t('workflows.triggerFields.fieldTypes.date'), value: 'date' }
])
const manualValid = computed(() => manual.value.inputFields.every(f => /^[a-z_][a-z0-9_]*$/i.test(f.name.trim()))
  && new Set(manual.value.inputFields.map(f => f.name.trim())).size === manual.value.inputFields.length)
const FOR_EACH_OPTIONS = computed(() => [
  { label: t('workflows.triggerFields.forEachRow'), value: 'ROW', description: t('workflows.triggerFields.forEachRowDescription', { path: '{{start.data.<column>}}' }) },
  { label: t('workflows.triggerFields.forEachStatement'), value: 'STATEMENT', description: t('workflows.triggerFields.forEachStatementDescription', { path: '{{start.data}}' }) }
])
/** A filter written as JSON: the object, null for none, undefined when it isn't valid. */
function parseFilterText(text: string): Record<string, unknown> | null | undefined {
  if (!text.trim()) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}
const filterError = computed(() => parseFilterText(dataEvent.value.filterText) === undefined ? t('workflows.triggerFields.filterInvalid') : undefined)
const oldFilterError = computed(() => parseFilterText(dataEvent.value.oldFilterText) === undefined ? t('workflows.triggerFields.filterInvalid') : undefined)
// The table's columns, for "Changed fields".
const tableColumns = ref<string[]>([])
watch(() => dataEvent.value.resource, async (resourceId) => {
  tableColumns.value = []
  if (!resourceId) return
  try {
    const { data } = await api.get<{ columns: { name: string }[] }>(`/catalog/table/${resourceId}`)
    tableColumns.value = data.columns.map(c => c.name)
  } catch {
    // The picker stays empty - the rest of the trigger still saves.
  }
}, { immediate: true })
// Loaded without blocking setup (no `await` - it would also stop
// defineExpose below from registering): the default fills in once the
// account arrives, unless a saved trigger or the admin set one first.
watch(workflowsSystemUserId, (id) => {
  if (id && dataEvent.value.executeAs === null) dataEvent.value.executeAs = id
}, { immediate: true })

// --- Schedule (Specification_Workflows.md §6.4) ---
const cron = ref({ expression: '', valid: false })
const timezoneOptions = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'])
// A new schedule starts in the author's own zone (My account > Preferences, else the instance's, else the browser's).
const cronConfig = ref({ timezone: useDateTimeFormat().timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone, executeAs: null as string | null })

// --- Webhook (Specification_Workflows.md §6.5, §13.2) ---
const webhook = ref({
  method: 'POST' as 'POST' | 'GET',
  responseMode: 'SYNC' as 'ASYNC' | 'SYNC',
  waitSeconds: 30,
  timeoutAction: 'CONTINUE' as 'CONTINUE' | 'CANCEL',
  access: 'PUBLIC' as 'AUTHENTICATED' | 'PUBLIC',
  executeAs: null as string | null
})

// Seeds every field this component controls directly. A saved
// `cron.expression` opens in CronScheduleFields as a Custom expression,
// unchanged (never back-parsed into a preset).
function parseInitial(config: Record<string, unknown> | undefined) {
  if (!config) return
  const trigger = config.trigger as string | undefined
  if (trigger === 'DATA_EVENT') {
    dataEvent.value = {
      resource: (config.resource as string | null) ?? null,
      events: (config.events as ('CREATE' | 'UPDATE' | 'DELETE')[] | undefined) ?? [],
      executeAs: (config.execute_as as string | null | undefined) ?? null,
      forEach: config.for_each === 'STATEMENT' ? 'STATEMENT' : 'ROW',
      filterText: config.filter ? JSON.stringify(config.filter, null, 2) : '',
      oldFilterText: config.old_filter ? JSON.stringify(config.old_filter, null, 2) : '',
      changedFields: Array.isArray(config.changed_fields) ? config.changed_fields as string[] : []
    }
  } else if (trigger === 'MANUAL') {
    manual.value = {
      executeAs: (config.execute_as as string | null | undefined) ?? null,
      inputFields: Array.isArray(config.input_fields) ? (config.input_fields as typeof manual.value.inputFields).map(f => ({ name: f.name, label: f.label ?? '', type: f.type, required: f.required === true })) : [],
      confirmMessage: (config.confirm_message as string | undefined) ?? ''
    }
  } else if (trigger === 'CRON') {
    cron.value = { expression: (config.cron_expression as string | undefined) ?? '', valid: false }
    cronConfig.value = {
      timezone: (config.timezone as string | undefined) ?? cronConfig.value.timezone,
      executeAs: (config.execute_as as string | null | undefined) ?? null
    }
  } else if (trigger === 'WEBHOOK') {
    webhook.value = {
      method: (config.method as 'POST' | 'GET' | undefined) ?? 'POST',
      responseMode: (config.response_mode as 'ASYNC' | 'SYNC' | undefined) ?? 'SYNC',
      waitSeconds: (config.wait_seconds as number | undefined) ?? 30,
      timeoutAction: (config.timeout_action as 'CONTINUE' | 'CANCEL' | undefined) ?? 'CONTINUE',
      access: (config.access as 'AUTHENTICATED' | 'PUBLIC' | undefined) ?? 'PUBLIC',
      executeAs: (config.execute_as as string | null | undefined) ?? null
    }
  }
}
parseInitial(props.initial)

const valid = computed(() => {
  if (kind.value === null) return false
  if (kind.value === 'DATA_EVENT') return dataEvent.value.resource !== null && dataEvent.value.events.length > 0 && dataEvent.value.executeAs !== null && !filterError.value && !oldFilterError.value
  if (kind.value === 'CRON') return cron.value.valid && cronConfig.value.timezone.trim().length > 0 && cronConfig.value.executeAs !== null
  if (kind.value === 'WEBHOOK') {
    if (webhook.value.access === 'PUBLIC' && webhook.value.executeAs === null) return false
    if (webhook.value.responseMode === 'SYNC' && webhook.value.waitSeconds <= 0) return false
    return true
  }
  return kind.value === 'MANUAL' && manualValid.value
})
watch(valid, v => emit('update:valid', v), { immediate: true })

function buildConfiguration(): Record<string, unknown> {
  if (kind.value === 'DATA_EVENT') {
    const updates = dataEvent.value.events.includes('UPDATE')
    const filter = parseFilterText(dataEvent.value.filterText)
    const oldFilter = updates ? parseFilterText(dataEvent.value.oldFilterText) : null
    return {
      trigger: 'DATA_EVENT',
      resource: dataEvent.value.resource,
      events: dataEvent.value.events,
      execute_as: dataEvent.value.executeAs,
      for_each: dataEvent.value.forEach,
      ...(filter ? { filter } : {}),
      ...(oldFilter ? { old_filter: oldFilter } : {}),
      ...(updates && dataEvent.value.changedFields.length > 0 ? { changed_fields: dataEvent.value.changedFields } : {})
    }
  }
  if (kind.value === 'CRON') {
    return { trigger: 'CRON', cron_expression: cron.value.expression, timezone: cronConfig.value.timezone, execute_as: cronConfig.value.executeAs }
  }
  if (kind.value === 'WEBHOOK') {
    return {
      trigger: 'WEBHOOK',
      method: webhook.value.method,
      response_mode: webhook.value.responseMode,
      ...(webhook.value.responseMode === 'SYNC' ? { wait_seconds: webhook.value.waitSeconds, timeout_action: webhook.value.timeoutAction } : {}),
      access: webhook.value.access,
      execute_as: webhook.value.executeAs
    }
  }
  if (kind.value === 'MANUAL') {
    return {
      trigger: 'MANUAL',
      ...(manual.value.executeAs ? { execute_as: manual.value.executeAs } : {}),
      ...(manual.value.inputFields.length > 0
        ? { input_fields: manual.value.inputFields.map(f => ({ name: f.name.trim(), ...(f.label.trim() ? { label: f.label.trim() } : {}), type: f.type, ...(f.required ? { required: true } : {}) })) }
        : {}),
      ...(manual.value.confirmMessage.trim() ? { confirm_message: manual.value.confirmMessage.trim() } : {})
    }
  }
  return { trigger: kind.value ?? 'MANUAL' }
}

// Any edit, valid or not - the settings page autosaves on it (a draft may hold an incomplete trigger).
watch(() => JSON.stringify(buildConfiguration()), () => emit('change'))

defineExpose({ buildConfiguration, valid })
</script>

<template>
  <!-- One root: the wizards hide the component with v-show, which a fragment could not take. -->
  <div class="flex flex-col gap-6">
    <div
      v-if="view !== 'config'"
      class="grid grid-cols-2 gap-3"
    >
      <button
        v-for="option in triggerOptions"
        :key="option.value"
        type="button"
        class="relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors"
        :class="kind === option.value ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated'"
        @click="kind = option.value"
      >
        <UIcon
          :name="option.icon"
          class="size-5"
          :class="kind === option.value ? 'text-primary' : 'text-muted'"
        />
        <span class="text-sm font-medium text-highlighted">{{ option.title }}</span>
        <span class="text-xs text-muted">{{ option.description }}</span>
      </button>
    </div>

    <template v-if="view !== 'cards'">
      <div
        v-if="kind === 'DATA_EVENT'"
        class="space-y-4"
      >
        <UFormField
          :label="t('workflows.triggerFields.table')"
          required
          :description="t('workflows.triggerFields.tableDescription')"
        >
          <USelect
            :model-value="dataEvent.resource ?? undefined"
            :items="tableItems"
            value-key="value"
            class="w-full"
            @update:model-value="(value: string) => { dataEvent.resource = value }"
          />
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.events')"
          required
          :description="t('workflows.triggerFields.eventsDescription')"
        >
          <UCheckboxGroup
            v-model="dataEvent.events"
            :items="[
              { label: t('workflows.triggerFields.eventCreate'), value: 'CREATE' },
              { label: t('workflows.triggerFields.eventUpdate'), value: 'UPDATE' },
              { label: t('workflows.triggerFields.eventDelete'), value: 'DELETE' }
            ]"
          />
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.forEach')"
          :description="t('workflows.triggerFields.forEachDescription')"
        >
          <URadioGroup
            v-model="dataEvent.forEach"
            :items="FOR_EACH_OPTIONS"
            :aria-label="t('workflows.triggerFields.forEach')"
          />
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.filter')"
          :error="filterError"
          :description="t('workflows.triggerFields.filterDescription', { example: '{ &quot;status&quot;: { &quot;_eq&quot;: &quot;PAID&quot; } }' })"
        >
          <JsonEditor
            v-model="dataEvent.filterText"
            min-height="5rem"
          />
        </UFormField>
        <template v-if="dataEvent.events.includes('UPDATE')">
          <UFormField
            :label="t('workflows.triggerFields.changedFields')"
            :description="t('workflows.triggerFields.changedFieldsDescription')"
          >
            <USelectMenu
              v-model="dataEvent.changedFields"
              :items="tableColumns"
              multiple
              :aria-label="t('workflows.triggerFields.changedFields')"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('workflows.triggerFields.oldFilter')"
            :error="oldFilterError"
            :description="t('workflows.triggerFields.oldFilterDescription', { example: '{ &quot;status&quot;: { &quot;_eq&quot;: &quot;PENDING&quot; } }' })"
          >
            <JsonEditor
              v-model="dataEvent.oldFilterText"
              min-height="5rem"
            />
          </UFormField>
        </template>
        <UFormField
          :label="t('workflows.triggerFields.executeAs')"
          required
          :description="t('workflows.triggerFields.executeAsDataEvent')"
        >
          <UserPicker
            v-model="dataEvent.executeAs"
            active-only
          />
        </UFormField>
      </div>

      <div
        v-else-if="kind === 'MANUAL'"
        class="space-y-4"
      >
        <UFormField
          :label="t('workflows.triggerFields.executeAs')"
          :description="t('workflows.triggerFields.executeAsManual')"
        >
          <UserPicker
            v-model="manual.executeAs"
            active-only
          />
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.inputForm')"
          :description="t('workflows.triggerFields.inputFormDescription')"
        >
          <div class="flex flex-col gap-2">
            <div
              v-for="(field, index) in manual.inputFields"
              :key="index"
              class="flex items-center gap-2 max-md:flex-col max-md:items-stretch"
            >
              <UInput
                v-model="field.name"
                class="flex-1 font-mono"
                :aria-label="t('workflows.triggerFields.inputFieldName', { n: index + 1 })"
              />
              <UInput
                v-model="field.label"
                class="flex-1"
                :aria-label="t('workflows.triggerFields.inputFieldLabel', { n: index + 1 })"
              />
              <USelect
                v-model="field.type"
                :items="FIELD_TYPES"
                class="w-32 max-md:w-full"
                :aria-label="t('workflows.triggerFields.inputFieldType', { n: index + 1 })"
              />
              <UCheckbox
                v-model="field.required"
                :label="t('common.required')"
              />
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                :aria-label="t('workflows.triggerFields.removeInputField', { n: index + 1 })"
                @click="manual.inputFields.splice(index, 1)"
              />
            </div>
            <p class="text-xs text-muted">
              {{ t('workflows.triggerFields.inputFieldsHelp') }}
            </p>
            <div>
              <UButton
                :label="t('workflows.triggerFields.addField')"
                icon="i-lucide-plus"
                size="xs"
                color="neutral"
                variant="outline"
                @click="manual.inputFields.push({ name: '', label: '', type: 'text', required: false })"
              />
            </div>
          </div>
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.confirmation')"
          :description="t('workflows.triggerFields.confirmationDescription')"
        >
          <UInput
            v-model="manual.confirmMessage"
            class="w-full"
          />
        </UFormField>
      </div>

      <div
        v-else-if="kind === 'CRON'"
        class="space-y-4"
      >
        <CronScheduleFields
          v-model="cron.expression"
          :timezone="cronConfig.timezone"
          :workflow-id="workflowId"
          @update:valid="cron.valid = $event"
        />
        <UFormField
          :label="t('workflows.triggerFields.timezone')"
          required
          :description="t('workflows.triggerFields.timezoneDescription')"
        >
          <USelectMenu
            v-model="cronConfig.timezone"
            :items="timezoneOptions"
            searchable
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('workflows.triggerFields.executeAs')"
          required
          :description="t('workflows.triggerFields.executeAsCron')"
        >
          <UserPicker
            v-model="cronConfig.executeAs"
            active-only
          />
        </UFormField>
      </div>

      <div
        v-else-if="kind === 'WEBHOOK'"
        class="space-y-4"
      >
        <UFormField
          :label="t('workflows.triggerFields.method')"
          :description="t('workflows.triggerFields.methodDescription')"
        >
          <URadioGroup
            v-model="webhook.method"
            orientation="horizontal"
            :items="[
              { label: 'POST', value: 'POST' },
              { label: 'GET', value: 'GET' }
            ]"
          />
        </UFormField>

        <UFormField
          :label="t('workflows.triggerFields.response')"
          :description="t('workflows.triggerFields.responseDescription')"
        >
          <URadioGroup
            v-model="webhook.responseMode"
            orientation="horizontal"
            :items="[
              { label: t('workflows.triggerFields.sync'), value: 'SYNC' },
              { label: t('workflows.triggerFields.async'), value: 'ASYNC' }
            ]"
          />
        </UFormField>

        <template v-if="webhook.responseMode === 'SYNC'">
          <UFormField
            :label="t('workflows.triggerFields.waitTime')"
            required
            :description="t('workflows.triggerFields.waitTimeDescription')"
          >
            <UInput
              v-model.number="webhook.waitSeconds"
              type="number"
              min="0"
              class="w-32"
            />
          </UFormField>
          <UFormField
            :label="t('workflows.triggerFields.onTimeout')"
            :description="t('workflows.triggerFields.onTimeoutDescription')"
          >
            <URadioGroup
              v-model="webhook.timeoutAction"
              orientation="horizontal"
              :items="[
                { label: t('workflows.triggerFields.continueInBackground'), value: 'CONTINUE' },
                { label: t('workflows.triggerFields.requestCancellation'), value: 'CANCEL' }
              ]"
            />
          </UFormField>
        </template>

        <UFormField
          :label="t('workflows.triggerFields.access')"
          :description="t('workflows.triggerFields.accessDescription')"
        >
          <URadioGroup
            v-model="webhook.access"
            orientation="horizontal"
            :items="[
              { label: t('workflows.triggerFields.public'), value: 'PUBLIC' },
              { label: t('workflows.triggerFields.authenticated'), value: 'AUTHENTICATED' }
            ]"
          />
        </UFormField>

        <UFormField
          :label="t('workflows.triggerFields.executeAs')"
          :required="webhook.access === 'PUBLIC'"
          :description="webhook.access === 'PUBLIC'
            ? t('workflows.triggerFields.executeAsWebhookPublic')
            : t('workflows.triggerFields.executeAsWebhookAuthenticated')"
        >
          <UserPicker
            v-model="webhook.executeAs"
            active-only
          />
        </UFormField>
      </div>
    </template>
  </div>
</template>
