<script setup lang="ts">
/**
 * The Dashboard editor's widget bar (Specification_Dashboards.md §10, D1): the page designer's format - a search,
 * the catalog's groups in capitals, each widget its icon and name (its description on hover). Picking one adds it at
 * the bottom of the canvas (the page does, on `add`). The editor's own column on desktop, a slideover on a phone
 * (pages/dashboards/[id].vue). Its groups are the catalog's: a new widget shows up in its own.
 */
import { DASHBOARD_WIDGET_GROUPS, type DashboardWidgetGroup } from '@totalbase/tb-catalog'
import { DASHBOARD_WIDGET_PALETTE, useDashboardCatalogText, type DashboardWidgetPaletteEntry } from '~/types/dashboard'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ add: [entry: DashboardWidgetPaletteEntry] }>()
const { t } = useI18n()
const catalog = useDashboardCatalogText()

const search = ref('')
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const groups = computed(() => {
  const query = fold(search.value.trim())
  return (Object.keys(DASHBOARD_WIDGET_GROUPS) as DashboardWidgetGroup[])
    .map(group => ({
      key: group,
      label: catalog.groupLabel(group),
      items: DASHBOARD_WIDGET_PALETTE.filter(e => e.group === group && (!query || fold(`${catalog.widgetLabel(e.type)} ${catalog.widgetDescription(e.type)} ${e.type}`).includes(query)))
    }))
    .filter(group => group.items.length > 0)
})
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-3">
    <UInput
      v-model="search"
      :aria-label="t('dashboards.palette.search')"
      icon="i-lucide-search"
      :placeholder="t('dashboards.palette.search')"
      size="sm"
    />
    <div
      v-for="group in groups"
      :key="group.key"
      class="flex flex-col gap-1"
    >
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">
        {{ group.label }}
      </p>
      <UTooltip
        v-for="entry in group.items"
        :key="entry.type"
        :text="catalog.widgetDescription(entry.type)"
        :content="{ side: 'right' }"
      >
        <!-- A native button: an option tile (icon + name), not a plain action. -->
        <button
          type="button"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated disabled:opacity-50"
          :disabled="disabled"
          @click="emit('add', entry)"
        >
          <UIcon
            :name="entry.icon"
            class="size-4 shrink-0 text-muted"
          />
          <span class="min-w-0 truncate">{{ catalog.widgetLabel(entry.type) }}</span>
        </button>
      </UTooltip>
    </div>
    <p
      v-if="groups.length === 0"
      class="text-xs text-muted"
    >
      {{ t('dashboards.palette.none') }}
    </p>
  </div>
</template>
