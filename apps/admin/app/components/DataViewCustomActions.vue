<script setup lang="ts">
/**
 * Settings › Actions › Custom actions (Specification_DataViews.md §3.7): the DataView's own actions - a function or
 * a MANUAL workflow on a row, the record or a selection - in their menu order. Each row its icon, label, where it
 * shows and what it runs; New action and ✎ open its panel (DataViewCustomActionEditor.vue). Saved with the
 * DataView's settings, published with it.
 */
import { MAX_CUSTOM_ACTIONS, type CustomAction } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import { CUSTOM_ACTION_ICON } from '~/utils/custom-actions'

const actions = defineModel<CustomAction[]>({ required: true })
defineProps<{
  /** The source's columns - a condition's filter builder, the arguments' templates. */
  columns?: CatalogColumn[]
  primaryKey: string | null
}>()

const { t } = useI18n()
const { resources } = useResourcesList()
const adminApi = useAdminApi()
const { data: workflows } = useAsyncData('custom-actions-workflows', () => adminApi.get<{ id: string, name: string, triggerType?: string | null }[]>('/workflows').then(r => r.data), { default: () => [] })

/** What an action runs, by name. */
function targetName(action: CustomAction): string {
  if (action.target.kind === 'FUNCTION') {
    const id = action.target.resource
    const fn = resources.value.find(r => r.id === id)
    return fn ? `${fn.schema}.${fn.name}` : t('designer.customActions.missingTarget')
  }
  const id = action.target.workflow
  return workflows.value.find(w => w.id === id)?.name ?? t('designer.customActions.missingTarget')
}
const placesText = (action: CustomAction) => action.places.map(p => t(`designer.customActions.places.${p}`)).join(' · ')

const editorOpen = ref(false)
/** The action in the panel - its index, or null for a new one. */
const editingIndex = ref<number | null>(null)
function openNew() {
  editingIndex.value = null
  editorOpen.value = true
}
function openEdit(index: number) {
  editingIndex.value = index
  editorOpen.value = true
}
function saved(action: CustomAction) {
  const next = [...actions.value]
  if (editingIndex.value === null) next.push(action)
  else next[editingIndex.value] = action
  actions.value = next
  editorOpen.value = false
}
function move(index: number, by: number) {
  const next = [...actions.value]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item!)
  actions.value = next
}
function remove(index: number) {
  actions.value = actions.value.filter((_, i) => i !== index)
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-highlighted">
          {{ t('designer.customActions.title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('designer.customActions.description') }}
        </p>
      </div>
      <UButton
        icon="i-lucide-plus"
        :label="t('designer.customActions.new')"
        color="neutral"
        variant="outline"
        :disabled="actions.length >= MAX_CUSTOM_ACTIONS"
        @click="openNew"
      />
    </div>
    <UEmpty
      v-if="actions.length === 0"
      icon="i-lucide-zap"
      :title="t('designer.customActions.emptyTitle')"
      :description="t('designer.customActions.emptyDescription')"
      variant="naked"
    />
    <ul
      v-else
      class="divide-y divide-default rounded-md border border-default"
    >
      <li
        v-for="(action, index) in actions"
        :key="action.id"
        class="flex items-center gap-3 px-3 py-2"
      >
        <UIcon
          :name="action.icon ?? CUSTOM_ACTION_ICON"
          class="size-4 shrink-0"
          :class="action.color === 'error' ? 'text-error' : 'text-muted'"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">
            {{ action.label }}
          </p>
          <p class="truncate text-xs text-muted">
            {{ placesText(action) }} · {{ targetName(action) }}
          </p>
        </div>
        <UButton
          icon="i-lucide-arrow-up"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === 0"
          :aria-label="t('designer.customActions.moveUp', { name: action.label })"
          @click="move(index, -1)"
        />
        <UButton
          icon="i-lucide-arrow-down"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === actions.length - 1"
          :aria-label="t('designer.customActions.moveDown', { name: action.label })"
          @click="move(index, 1)"
        />
        <UButton
          icon="i-lucide-pencil"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('designer.customActions.edit', { name: action.label })"
          @click="openEdit(index)"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('designer.customActions.remove', { name: action.label })"
          @click="remove(index)"
        />
      </li>
    </ul>
    <DataViewCustomActionEditor
      v-if="editorOpen"
      v-model:open="editorOpen"
      :action="editingIndex === null ? null : actions[editingIndex] ?? null"
      :taken-ids="actions.filter((_, i) => i !== editingIndex).map(a => a.id)"
      :columns="columns"
      :primary-key="primaryKey"
      :functions="resources.filter(r => r.type === 'FUNCTION' && r.status === 'ACTIVE' && r.exposedMethods.includes('POST'))"
      :workflows="workflows.filter(w => w.triggerType === 'MANUAL')"
      @save="saved"
    />
  </section>
</template>
