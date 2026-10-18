<script setup lang="ts">
// Wraps JsonEditor with the UFormField chrome + a minimal toolbar
// (Format, and - when `columns` is given - a visual condition Builder)
// shared by every place that edits one filter-object expression in this
// grammar - the Data API's own where[...], a permission's row filter,
// and a Validation Rule (roles/[id].vue) - see AGENTS.md section 7 "The
// filter-object grammar - one grammar, three uses". Named after the
// domain term ("where") already used throughout the project, not
// "filter" (which reads as a grid search box elsewhere in the admin).
//
// Simple/Advanced: Advanced is this same Monaco editor,
// unchanged. Simple keeps the Builder always open (not tucked in a
// popover) with each condition rendered as a card and, once there are
// 2+, a single AND/OR toggle for the WHOLE group - not per-pair logic,
// which would be ambiguous without nested groups (out of scope here).
import type { TableColumn } from '@nuxt/ui'
import type { CatalogColumn } from '~/types/permission'
import { formatCondition, humanizeCondition, parseConditions, serializeConditions, type Condition, type ConditionJoin } from '~/utils/filterConditions'

type Mode = 'simple' | 'advanced'

const modelValue = defineModel<string>({ required: true })
const props = withDefaults(defineProps<{
  label: string
  description?: string | undefined
  error?: string | null | undefined
  minHeight?: string
  /** Enables the Builder (and the Simple/Advanced toggle at all) - omit where no column list applies (e.g. a resource-less filter) and the toolbar just keeps Format, always in Advanced mode. */
  columns?: CatalogColumn[] | undefined
  /** A condition's value as its caller reads it - a picked key by its row's presentation; none: as written. */
  valueText?: ((condition: Condition) => string | undefined) | undefined
  /** The column the builder starts on - a column's own conditions (ColumnConditionsEditor.vue); the viewer may pick another. */
  defaultField?: string | undefined
  /** Which mode a field with `columns` starts in. Every existing caller stays 'advanced' (the default) - pass 'simple' only for a freshly-created/empty filter where the builder is the more approachable start. Forced to 'advanced' regardless, when the initial value is too complex to build on (see canBuild below) - a starting preference, not a guarantee. */
  defaultMode?: Mode
}>(), {
  description: undefined,
  error: undefined,
  minHeight: '10rem',
  columns: undefined,
  defaultField: undefined,
  defaultMode: 'advanced'
})

const { t } = useI18n()
const editorRef = ref<{ format: () => void } | null>(null)

// Best-effort read of the current JSON as a list of chips - null means
// "too complex to show/build on" (see parseConditions' own doc), not
// empty; the Builder/Simple mode are disabled rather than risking
// silently replacing a hand-written nested expression.
const group = computed(() => parseConditions(modelValue.value))
const conditions = computed<Condition[]>(() => group.value?.conditions ?? [])
const join = computed<ConditionJoin>(() => group.value?.join ?? 'and')
const canBuild = computed(() => group.value !== null)
const canUseSimple = computed(() => !!props.columns && canBuild.value)
/** A condition's column as its caller titles it (`CatalogColumn.label`) - none: its name, in mono. */
function labelOf(name: string): string | undefined {
  const label = props.columns?.find(c => c.name === name)?.label
  return label && label !== name ? label : undefined
}
// Simple-mode table rows - humanized once per condition rather than per cell.
const humanizedConditions = computed(() => conditions.value.map(humanizeCondition))
const CONDITION_COLUMNS = computed<TableColumn<ReturnType<typeof humanizeCondition>>[]>(() => [
  { id: 'field', header: t('database.whereField.field') },
  { accessorKey: 'operatorLabel', header: t('database.whereField.operator') },
  { id: 'value', header: t('common.value') },
  { id: 'remove', header: '', meta: { class: { th: 'w-8', td: 'w-8' } } }
])

const mode = ref<Mode>(canUseSimple.value ? props.defaultMode : 'advanced')
// `columns` often arrives asynchronously (e.g. DataViewGrid.vue's Filter
// sidebar fetches it lazily the first time it opens - see that file's
// own comment) - this component mounts before that resolves, so the
// ref init above can miss `defaultMode`. Re-apply it the moment
// canUseSimple first turns true, unless the viewer already picked a
// mode themselves by then. Also covers the reverse: the value turning
// "too complex" out from under Simple mode via an Advanced edit (Simple
// mode itself can never write anything parseConditions can't read
// back) - fall back to Advanced rather than showing a builder with
// nothing left to build on.
let userChangedMode = false
watch(canUseSimple, (ok) => {
  if (!ok) mode.value = 'advanced'
  else if (!userChangedMode) mode.value = props.defaultMode
})

function setMode(next: Mode) {
  userChangedMode = true
  mode.value = next
}

const isBuilderOpen = ref(false)

function addCondition(condition: Condition) {
  // Belt-and-braces alongside the Build button's own :disabled="!canBuild"
  // (a Popover trigger's disabled state is a UI nicety, not a hard
  // guarantee this handler can't fire) - never build on top of a null
  // parse, that's exactly the "too complex, don't touch it" case.
  if (group.value === null) return
  modelValue.value = serializeConditions([...group.value.conditions, condition], join.value)
  isBuilderOpen.value = false
}

function removeCondition(index: number) {
  if (!group.value) return
  modelValue.value = serializeConditions(group.value.conditions.filter((_, i) => i !== index), join.value)
}

function setJoin(next: ConditionJoin) {
  if (!group.value) return
  modelValue.value = serializeConditions(group.value.conditions, next)
}
</script>

<template>
  <UFormField
    :label="label"
    :description="description"
    :error="error ?? undefined"
  >
    <div class="rounded-md border border-default p-[10px] mt-2">
      <div class="flex items-center justify-between gap-2 pb-2">
        <UFieldGroup v-if="columns">
          <UButton
            :label="t('database.whereField.simple')"
            size="xs"
            :color="mode === 'simple' ? 'primary' : 'neutral'"
            :variant="mode === 'simple' ? 'solid' : 'outline'"
            :disabled="!canUseSimple"
            @click="setMode('simple')"
          />
          <UButton
            :label="t('database.whereField.advanced')"
            size="xs"
            :color="mode === 'advanced' ? 'primary' : 'neutral'"
            :variant="mode === 'advanced' ? 'solid' : 'outline'"
            @click="setMode('advanced')"
          />
        </UFieldGroup>
        <div v-else />

        <!-- Right slot: Build/Format in Advanced, or - in Simple, once
        there's 1+ condition - the Match AND/OR selector, so it's
        visible/settable while composing the NEXT condition in the
        builder below, not just after adding it. One toggle for the
        WHOLE group (see the file's own top-of-script doc on why not
        per-pair). -->
        <div
          v-if="mode === 'advanced'"
          class="flex gap-1"
        >
          <UPopover
            v-if="columns"
            v-model:open="isBuilderOpen"
          >
            <UTooltip :text="canBuild ? t('database.whereField.buildCondition') : t('database.whereField.tooComplex')">
              <UButton
                :label="t('database.whereField.build')"
                icon="i-lucide-list-plus"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="!canBuild"
              />
            </UTooltip>
            <template #content>
              <div class="w-80 p-3">
                <FilterConditionBuilder
                  :columns="columns"
                  :default-field="defaultField"
                  @add="addCondition"
                />
              </div>
            </template>
          </UPopover>
          <UButton
            :label="t('database.whereField.format')"
            icon="i-lucide-wand-sparkles"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="editorRef?.format()"
          />
        </div>
        <div
          v-else-if="conditions.length > 0"
          class="flex items-center gap-2 text-xs text-muted"
        >
          <span>{{ t('database.whereField.match') }}</span>
          <UFieldGroup>
            <UTooltip :text="t('database.whereField.matchAll')">
              <UButton
                label="AND"
                size="xs"
                :color="join === 'and' ? 'primary' : 'neutral'"
                :variant="join === 'and' ? 'solid' : 'outline'"
                @click="setJoin('and')"
              />
            </UTooltip>
            <UTooltip :text="t('database.whereField.matchAny')">
              <UButton
                label="OR"
                size="xs"
                :color="join === 'or' ? 'primary' : 'neutral'"
                :variant="join === 'or' ? 'solid' : 'outline'"
                @click="setJoin('or')"
              />
            </UTooltip>
          </UFieldGroup>
        </div>
        <div v-else />
      </div>
      <USeparator />

      <template v-if="mode === 'simple'">
        <FilterConditionBuilder
          :columns="columns!"
          :default-field="defaultField"
          class="py-3"
          @add="addCondition"
        />
        <template v-if="conditions.length > 0">
          <USeparator />
          <UTable
            sticky
            :data="humanizedConditions"
            :columns="CONDITION_COLUMNS"
            class="mt-3"
          >
            <template #field-cell="{ row }">
              <UBadge
                v-if="row.index > 0"
                :label="join.toUpperCase()"
                color="neutral"
                variant="subtle"
                size="sm"
                class="mr-2"
              />
              <span
                v-if="labelOf(row.original.field)"
                :title="row.original.field"
              >{{ labelOf(row.original.field) }}</span>
              <span
                v-else
                class="font-mono"
              >{{ row.original.field }}</span>
            </template>
            <template #value-cell="{ row }">
              <span
                v-if="valueText?.(conditions[row.index]!)"
                :title="row.original.value"
              >{{ valueText(conditions[row.index]!) }}</span>
              <span
                v-else
                class="font-mono"
              >{{ row.original.value }}</span>
            </template>
            <template #remove-cell="{ row }">
              <UButton
                :aria-label="t('common.remove')"
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="link"
                class="p-0"
                @click="removeCondition(row.index)"
              />
            </template>
          </UTable>
        </template>
        <p
          v-else
          class="text-xs text-muted pt-3"
        >
          {{ t('database.whereField.noConditions') }}
        </p>
      </template>

      <JsonEditor
        v-show="mode === 'advanced'"
        ref="editorRef"
        v-model="modelValue"
        :min-height="minHeight"
      />
      <div
        v-if="mode === 'advanced' && conditions.length > 0"
        class="flex flex-wrap items-center gap-1.5 mt-2"
      >
        <UBadge
          v-for="(condition, index) in conditions"
          :key="index"
          color="neutral"
          variant="subtle"
          class="font-mono"
        >
          {{ formatCondition(condition) }}
          <UButton
            :aria-label="t('common.remove')"
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="link"
            class="p-0 ml-1"
            @click="removeCondition(index)"
          />
        </UBadge>
      </div>
    </div>
  </UFormField>
</template>
