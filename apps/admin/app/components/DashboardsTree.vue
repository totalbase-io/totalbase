<script setup lang="ts">
/**
 * The Dashboards rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'dashboards'`) - same "flat list, search, leaf
 * click jumps straight into edit mode, own New button" pattern
 * WorkflowsTree.vue uses for Workflows, applied to Dashboards. No type
 * grouping (a Dashboard has no DataView-style viewType category), so
 * this is a flat searchable list, same as Workflows.
 *
 * New is a choice: Blank (DashboardCreateModal.vue - identity only, see
 * its own doc comment) or From a table (DashboardFromTableWizard.vue, the
 * dashboard assistant), both opened from here.
 *
 * Same row as the DataViews sidebar: the icon keeps the Dashboard's own
 * color, the badge carries the versioning status (utils/publish-status.ts)
 * - a Dashboard has no type, so the badge reads the status itself.
 */
import type { Dashboard } from '~/types/dashboard'
import { identityIconStyle, publishStatus, PUBLISH_STATUS_META } from '~/utils/publish-status'
import { useBrokenReferences } from '~/composables/useBrokenReferences'

const { dashboards, refresh, error } = useAppsNavDashboards()
// Widgets whose query PostgreSQL refuses - a column or a table it names is gone (Dashboards.md §2.8).
const broken = useBrokenReferences()
onMounted(broken.ensure)
function brokenText(id: string): string | null {
  const widgets = broken.dashboardProblems.value.get(id)
  if (!widgets?.length) return null
  return t('dashboards.tree.brokenWidgets', { widgets: widgets.map(w => w.widget.label || w.widget.type).join(', ') }, widgets.length)
}
const { t } = useI18n()

const search = ref('')
const dashboardsFiltered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (dashboards.value ?? [])
    .filter(d => !query || d.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const surfaceTone = useSurfaceTone()

function openDashboard(id: string) {
  navigateTo(`/dashboards/${id}`)
}

// Shared with the empty Dashboards page, whose two large buttons open the same two (D29).
const open = useState('dashboards-new-blank', () => false)
// New › From a table: the dashboard assistant (Dashboards.md §10.7) - loaded on first open.
const fromTableOpen = useState('dashboards-new-from-table', () => false)
const fromTableMounted = useOpenedOnce(fromTableOpen)
const newItems = computed(() => [[
  { label: t('dashboards.fromTable.blank'), description: t('dashboards.index.blankDescription'), icon: 'i-lucide-square-dashed', onSelect: () => { open.value = true } },
  { label: t('dashboards.fromTable.menu'), description: t('dashboards.index.fromTableDescription'), icon: 'i-lucide-table', onSelect: () => { fromTableOpen.value = true } }
]])

async function onCreated(dashboard: Pick<Dashboard, 'id'>) {
  await refresh()
  await navigateTo(`/dashboards/${dashboard.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UDropdownMenu
      :items="newItems"
      :content="{ align: 'start' }"
      :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width)' }"
    >
      <UButton
        icon="i-lucide-plus"
        trailing-icon="i-lucide-chevron-down"
        :label="t('dashboards.createModal.title')"
        block
      />
    </UDropdownMenu>
    <UInput
      v-model="search"
      icon="i-lucide-search"
      :aria-label="t('dashboards.tree.searchLabel')"
      :placeholder="t('dashboards.tree.search')"
      class="w-full"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('dashboards.tree.loadFailed')"
    />
    <div
      v-else
      class="flex flex-col"
    >
      <button
        v-for="dashboard in dashboardsFiltered"
        :key="dashboard.id"
        type="button"
        class="flex min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-elevated hover:text-highlighted"
        :class="PUBLISH_STATUS_META[publishStatus(dashboard)].name"
        @click="openDashboard(dashboard.id)"
      >
        <UIcon
          :name="dashboard.icon || 'i-lucide-layout-dashboard'"
          class="size-4 shrink-0 text-muted"
          :style="identityIconStyle(dashboard.color, surfaceTone)"
        />
        <span class="truncate">{{ dashboard.name }}</span>
        <UTooltip
          v-if="brokenText(dashboard.id)"
          :text="brokenText(dashboard.id)!"
          class="shrink-0"
        >
          <UIcon
            name="i-lucide-triangle-alert"
            class="size-3.5 shrink-0 text-error"
            :aria-label="brokenText(dashboard.id)!"
          />
        </UTooltip>
        <span
          v-if="dashboard.scope === 'EMBEDDED_ONLY'"
          class="sr-only"
        >{{ t('dashboards.tree.notInMenu') }}</span>
        <UTooltip
          v-if="dashboard.scope === 'EMBEDDED_ONLY'"
          :text="t('dashboards.tree.notInMenuHelp')"
          class="ms-auto shrink-0"
        >
          <UIcon
            name="i-lucide-eye-off"
            class="size-3.5 shrink-0 text-dimmed"
          />
        </UTooltip>
        <UTooltip
          :text="t(PUBLISH_STATUS_META[publishStatus(dashboard)].labelKey)"
          :class="dashboard.scope === 'EMBEDDED_ONLY' ? 'shrink-0' : 'ms-auto shrink-0'"
        >
          <UBadge
            :label="t(PUBLISH_STATUS_META[publishStatus(dashboard)].shortKey)"
            :color="PUBLISH_STATUS_META[publishStatus(dashboard)].badge"
            variant="subtle"
            size="sm"
            class="ms-auto shrink-0"
          />
        </UTooltip>
      </button>
      <p
        v-if="dashboardsFiltered.length === 0"
        class="px-2 py-2 text-xs text-muted"
      >
        {{ t('dashboards.tree.empty') }}
      </p>
    </div>

    <DashboardCreateModal
      v-model:open="open"
      @created="onCreated"
    />
    <LazyDashboardFromTableWizard
      v-if="fromTableMounted"
      v-model:open="fromTableOpen"
      @created="id => onCreated({ id })"
    />
  </div>
</template>
