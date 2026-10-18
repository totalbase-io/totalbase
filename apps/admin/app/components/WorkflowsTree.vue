<script setup lang="ts">
/**
 * The Workflows rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'workflows'`) - same "flat list, search, leaf click
 * jumps straight to its own detail page, own New button" pattern
 * DataViewsTree.vue uses for DataViews, applied to workflows. No type
 * grouping (workflows don't have DataView's viewType-style category), so
 * this is simpler: one flat searchable list.
 *
 * Creation lives in NewWorkflowModal.vue's three-step wizard (Specification_Workflows.md §16.1),
 * opened from here (not the /workflows landing page anymore) since the list
 * itself moved into the sidebar - see pages/workflows/index.vue.
 *
 * Each row's icon reflects its Start node's configured trigger kind (same
 * icon set as the wizard's own trigger cards, TRIGGER_OPTIONS) - the
 * server resolves `triggerType` from the draft definition in one query
 * (workflows-admin-service.ts's own `list()`), so this never fetches a
 * draft per row. `null`/unconfigured falls back to the generic workflow icon.
 *
 * Deliberately no per-row delete here (a hover-reveal trash icon used to
 * live here) - the user asked for it to live only in the editor's own
 * header ([id].vue's Delete button), not duplicated in the list, so a
 * workflow can't be deleted without opening it first.
 *
 * Same row as the DataViews and Dashboards sidebars: the versioning status
 * badge on the right - Live/Changes/Draft (utils/publish-status.ts). The
 * trigger needs no badge of its own: the row's icon already is the
 * trigger's, with its name as a tooltip. A workflow has no color of its
 * own, so that icon stays neutral.
 */
import { TRIGGER_ICONS, useTriggerOptions } from '~/utils/workflow-triggers'
import { publishStatus, PUBLISH_STATUS_META } from '~/utils/publish-status'

interface Workflow { id: string, name: string, description: string | null, slug: string, triggerType?: string | null, liveVersion?: number | null, hasUnpublishedChanges?: boolean }

const { t } = useI18n()
const triggerOptions = useTriggerOptions()
const TRIGGER_ICON: Record<string, string> = TRIGGER_ICONS
const triggerLabels = computed<Record<string, string>>(() => Object.fromEntries(triggerOptions.value.map(o => [o.value, o.title])))
function workflowIcon(workflow: Workflow): string {
  return (workflow.triggerType && TRIGGER_ICON[workflow.triggerType]) || 'i-lucide-workflow'
}
function triggerLabel(workflow: Workflow): string {
  return (workflow.triggerType && triggerLabels.value[workflow.triggerType]) || t('workflows.tree.noTrigger')
}

const api = useAdminApi()

const { data: workflows, refresh, error } = await useAsyncData(
  'workflows-tree',
  () => api.get<Workflow[]>('/workflows').then(r => r.data),
  { default: () => [] }
)

const search = ref('')
const workflowsFiltered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (workflows.value ?? [])
    .filter(w => !query || w.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
})

function openWorkflow(id: string) {
  navigateTo(`/workflows/${id}`)
}

const open = ref(false)

async function onCreated(workflow: Workflow) {
  await refresh()
  await navigateTo(`/workflows/${workflow.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      icon="i-lucide-plus"
      :label="t('workflows.tree.newWorkflow')"
      block
      @click="open = true"
    />
    <UInput
      v-model="search"
      icon="i-lucide-search"
      :aria-label="t('workflows.tree.searchAria')"
      :placeholder="t('workflows.tree.searchPlaceholder')"
      class="w-full"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('workflows.tree.loadFailed')"
    />
    <div
      v-else
      class="flex flex-col"
    >
      <button
        v-for="workflow in workflowsFiltered"
        :key="workflow.id"
        type="button"
        class="flex min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-elevated hover:text-highlighted"
        :class="PUBLISH_STATUS_META[publishStatus(workflow)].name"
        @click="openWorkflow(workflow.id)"
      >
        <UTooltip
          :text="triggerLabel(workflow)"
          class="shrink-0"
        >
          <UIcon
            :name="workflowIcon(workflow)"
            class="size-4 shrink-0 text-muted"
          />
        </UTooltip>
        <span class="truncate">{{ workflow.name }}</span>
        <span class="sr-only">({{ triggerLabel(workflow) }}, {{ t(PUBLISH_STATUS_META[publishStatus(workflow)].labelKey) }})</span>
        <UTooltip
          :text="t(PUBLISH_STATUS_META[publishStatus(workflow)].labelKey)"
          class="ms-auto shrink-0"
        >
          <UBadge
            :label="t(PUBLISH_STATUS_META[publishStatus(workflow)].shortKey)"
            :color="PUBLISH_STATUS_META[publishStatus(workflow)].badge"
            variant="subtle"
            size="sm"
            class="ms-auto shrink-0"
          />
        </UTooltip>
      </button>
      <p
        v-if="workflowsFiltered.length === 0"
        class="px-2 py-2 text-xs text-muted"
      >
        {{ t('workflows.tree.empty') }}
      </p>
    </div>

    <NewWorkflowModal
      v-model:open="open"
      @created="onCreated"
    />
  </div>
</template>
