<script setup lang="ts">
/**
 * One custom action's panel (Specification_DataViews.md §3.7) - Settings › Actions › New action or ✎: its label,
 * icon and color; what it runs (a function or a MANUAL workflow) and what it sends (each argument a template:
 * `{{column}}` of the row, `{{ids}}` the selection's keys); where it shows; when (a filter, PostgreSQL deciding);
 * and an optional confirmation. Saved into the list it came from; the server checks it whole.
 */
import { CUSTOM_ACTION_COLORS, CUSTOM_ACTION_PLACES, type CustomAction, type CustomActionPlace } from '@totalbase/tb-catalog'
import { slugify } from '@totalbase/shared'
import type { CatalogColumn } from '~/types/permission'
import type { Resource } from '~/types/resource'
import type { FunctionDetail } from '~/types/schema'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  /** The action edited - null: a new one. */
  action: CustomAction | null
  /** The other actions' ids - a new one's must differ. */
  takenIds: string[]
  columns?: CatalogColumn[]
  primaryKey: string | null
  functions: Resource[]
  workflows: { id: string, name: string }[]
}>()
const emit = defineEmits<{ save: [action: CustomAction] }>()
const { t } = useI18n()
const adminApi = useAdminApi()

const label = ref(props.action?.label ?? '')
const icon = ref<string | undefined>(props.action?.icon)
const color = ref<CustomAction['color']>(props.action?.color ?? 'neutral')
const kind = ref<'FUNCTION' | 'WORKFLOW'>(props.action?.target.kind ?? 'FUNCTION')
const functionId = ref(props.action?.target.kind === 'FUNCTION' ? props.action.target.resource : undefined)
const workflowId = ref(props.action?.target.kind === 'WORKFLOW' ? props.action.target.workflow : undefined)
const places = ref<CustomActionPlace[]>(props.action?.places ? [...props.action.places] : ['row', 'record'])
const whereText = ref(props.action?.where ? JSON.stringify(props.action.where, null, 2) : '')
const confirmOn = ref(!!props.action?.confirm)
const confirmText = ref(props.action?.confirm?.text ?? '')
const confirmDanger = ref(props.action?.confirm?.danger ?? false)
const args = ref<Record<string, string>>({ ...(props.action?.args ?? {}) })

const KIND_ITEMS = computed(() => [
  { label: t('designer.customActions.kinds.function'), value: 'FUNCTION' },
  { label: t('designer.customActions.kinds.workflow'), value: 'WORKFLOW' }
])
const COLOR_ITEMS = computed(() => CUSTOM_ACTION_COLORS.map(c => ({ label: t(`designer.customActions.colors.${c}`), value: c })))
const PLACE_ITEMS = computed(() => CUSTOM_ACTION_PLACES.map(p => ({ label: t(`designer.customActions.places.${p}`), value: p })))
const functionItems = computed(() => props.functions.map(f => ({ label: `${f.schema}.${f.name}`, description: f.description ?? undefined, value: f.id })))
const workflowItems = computed(() => props.workflows.map(w => ({ label: w.name, value: w.id })))

/** The key a row sends by default - `{{ids}}` when it only runs on a selection. */
const keyTemplate = computed(() => (places.value.length === 1 && places.value[0] === 'selection' ? '{{ids}}' : `{{${props.primaryKey ?? 'id'}}}`))

// --- What it sends: a function's parameters, a workflow's input fields - each a template. ---
const argNames = ref<string[]>(Object.keys(args.value))
async function loadArgs() {
  try {
    if (kind.value === 'FUNCTION') {
      const fn = props.functions.find(f => f.id === functionId.value)
      if (!fn) return void (argNames.value = [])
      const { data } = await adminApi.get<FunctionDetail>(`/catalog/function/${fn.postgresOid}`)
      argNames.value = data.parameters.map(p => p.name).filter(Boolean)
      // A new function's first parameter takes the row's key - every selected key when it's a list (uuid[]).
      const first = data.parameters.find(p => p.name)
      if (first && Object.keys(args.value).length === 0) args.value = { [first.name]: first.dataType.endsWith('[]') ? '{{ids}}' : keyTemplate.value }
    } else {
      if (!workflowId.value) return void (argNames.value = [])
      const { data } = await adminApi.get<{ definition: { operations?: { type: string, configuration?: { input_fields?: { name: string }[] } }[] } }>(`/workflows/${workflowId.value}/draft`)
      const start = data.definition.operations?.find(op => op.type === 'totalbase.start')
      argNames.value = (start?.configuration?.input_fields ?? []).map(f => f.name)
    }
  } catch {
    argNames.value = Object.keys(args.value)
  }
}
watch([kind, functionId, workflowId], (now, before) => {
  // Another target: its own arguments.
  if (before && (now[0] !== before[0] || now[1] !== before[1] || now[2] !== before[2])) args.value = {}
  void loadArgs()
}, { immediate: true })
function setArg(name: string, value: string) {
  args.value = Object.fromEntries([...Object.entries(args.value).filter(([key]) => key !== name), ...(value.trim() ? [[name, value]] : [])])
}

// --- Checks before it goes back to the list (the server checks it whole). ---
const whereError = computed(() => {
  if (!whereText.value.trim()) return null
  try {
    const parsed = JSON.parse(whereText.value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? null : t('designer.customActions.whereObject')
  } catch {
    return t('designer.customActions.whereJson')
  }
})
const valid = computed(() => label.value.trim().length > 0 && label.value.length <= 32 && places.value.length > 0
  && (kind.value === 'FUNCTION' ? !!functionId.value : !!workflowId.value) && !whereError.value && (!confirmOn.value || confirmText.value.trim().length > 0))

/** Its id: kept once set; a new one's from its label, unique among the others. */
function idFor(): string {
  if (props.action) return props.action.id
  const base = (slugify(label.value).replace(/-/g, '_').replace(/^[^a-z]+/, '') || 'action').slice(0, 24)
  let id = base
  for (let n = 2; props.takenIds.includes(id); n++) id = `${base}_${n}`
  return id
}
function save() {
  if (!valid.value) return
  emit('save', {
    id: idFor(),
    label: label.value.trim(),
    ...(icon.value ? { icon: icon.value } : {}),
    ...(color.value && color.value !== 'neutral' ? { color: color.value } : {}),
    target: kind.value === 'FUNCTION' ? { kind: 'FUNCTION', resource: functionId.value! } : { kind: 'WORKFLOW', workflow: workflowId.value! },
    ...(Object.keys(args.value).length ? { args: args.value } : {}),
    places: CUSTOM_ACTION_PLACES.filter(p => places.value.includes(p)),
    ...(whereText.value.trim() ? { where: JSON.parse(whereText.value) as Record<string, unknown> } : {}),
    ...(confirmOn.value ? { confirm: { text: confirmText.value.trim(), ...(confirmDanger.value ? { danger: true } : {}) } } : {})
  })
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="action ? t('designer.customActions.editTitle', { name: action.label }) : t('designer.customActions.newTitle')"
    :description="t('designer.customActions.panelDescription')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <UFormField
          :label="t('designer.customActions.label')"
          :description="t('designer.customActions.labelHelp')"
          required
        >
          <UInput
            v-model="label"
            class="w-full"
            :maxlength="32"
          />
        </UFormField>
        <div class="flex gap-3 max-md:flex-col">
          <IconPickerField
            v-model="icon"
            :label="t('common.icon')"
            clearable
          />
          <UFormField
            :label="t('common.color')"
            class="min-w-40"
          >
            <USelect
              v-model="color"
              :items="COLOR_ITEMS"
              class="w-full"
            />
          </UFormField>
        </div>

        <USeparator />
        <UFormField
          :label="t('designer.customActions.runs')"
          required
        >
          <URadioGroup
            v-model="kind"
            :items="KIND_ITEMS"
            orientation="horizontal"
          />
        </UFormField>
        <UFormField
          v-if="kind === 'FUNCTION'"
          :label="t('designer.customActions.function')"
          :description="t('designer.customActions.functionHelp')"
          required
        >
          <USelectMenu
            v-model="functionId"
            :items="functionItems"
            value-key="value"
            :aria-label="t('designer.customActions.function')"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-else
          :label="t('designer.customActions.workflow')"
          :description="t('designer.customActions.workflowHelp')"
          required
        >
          <USelectMenu
            v-model="workflowId"
            :items="workflowItems"
            value-key="value"
            :aria-label="t('designer.customActions.workflow')"
            class="w-full"
          />
        </UFormField>
        <div
          v-if="argNames.length"
          class="flex flex-col gap-3"
        >
          <p class="text-sm text-muted">
            {{ t('designer.customActions.argsHelp', { key: keyTemplate }) }}
          </p>
          <UFormField
            v-for="name in argNames"
            :key="name"
            :label="name"
          >
            <UInput
              :model-value="args[name] ?? ''"
              class="w-full font-mono"
              @update:model-value="(value: string | number) => setArg(name, String(value))"
            />
          </UFormField>
        </div>
        <p
          v-else-if="kind === 'WORKFLOW' && workflowId"
          class="text-sm text-muted"
        >
          {{ t('designer.customActions.workflowDefault') }}
        </p>

        <USeparator />
        <UFormField
          :label="t('designer.customActions.where')"
          :description="t('designer.customActions.whereHelp')"
          required
        >
          <UCheckboxGroup
            v-model="places"
            :items="PLACE_ITEMS"
            orientation="horizontal"
          />
        </UFormField>
        <WhereField
          v-model="whereText"
          :label="t('designer.customActions.when')"
          :description="t('designer.customActions.whenHelp')"
          :error="whereError ?? undefined"
          :columns="columns"
          default-mode="simple"
        />

        <USeparator />
        <USwitch
          v-model="confirmOn"
          :label="t('designer.customActions.confirm')"
          :description="t('designer.customActions.confirmHelp')"
        />
        <template v-if="confirmOn">
          <UFormField
            :label="t('designer.customActions.confirmText')"
            :description="t('designer.customActions.confirmTextHelp')"
            required
          >
            <UTextarea
              v-model="confirmText"
              class="w-full"
              :rows="2"
              :maxlength="200"
            />
          </UFormField>
          <USwitch
            v-model="confirmDanger"
            :label="t('designer.customActions.danger')"
          />
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('common.save')"
          :disabled="!valid"
          @click="save"
        />
      </div>
    </template>
  </USlideover>
</template>
