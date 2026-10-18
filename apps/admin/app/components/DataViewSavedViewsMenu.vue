<script setup lang="ts">
/**
 * The toolbar's views (Specification_DataViews.md §5.9), all in one popover: Default, My views and Shared - a click
 * opens one -, on a phone the DataView's view types, and Save current view…. A saved view never changes: what's on
 * screen is saved as a view, under the name of one of one's own to replace it (SaveViewForm.vue). Each of one's own
 * views shares (its icon marked while shared) and deletes, asked on its row.
 * Props in, events out (AGENTS.md §21A): the grid owns the state, the list, every write and the share dialog.
 */
import type { DataViewType, SavedView } from '~/types/dataview'

const props = defineProps<{
  views: SavedView[]
  /** The open saved view - null: Default. */
  activeId: string | null
  /** The DataView's views, listed here on a phone - empty otherwise. */
  layouts: { type: DataViewType, label: string, icon: string }[]
  activeLayout: DataViewType
  saving?: boolean
}>()
const emit = defineEmits<{
  select: [id: string | null]
  layout: [type: DataViewType]
  saveNew: [name: string]
  replace: [id: string]
  remove: [id: string]
  share: [id: string]
}>()

const { t } = useI18n()
const open = ref(false)

const active = computed(() => props.views.find(v => v.id === props.activeId) ?? null)
const label = computed(() => t('dataviews.savedViews.selector', { name: active.value?.name ?? t('dataviews.savedViews.default') }))
const mine = computed(() => props.views.filter(v => v.isOwner))
const shared = computed(() => props.views.filter(v => !v.isOwner))

function select(id: string | null) {
  emit('select', id)
  open.value = false
}

const saveFormOpen = ref(false)
/** The view a row asks to delete. */
const removingId = ref<string | null>(null)
watch(open, (isOpen) => {
  if (isOpen) return
  saveFormOpen.value = false
  removingId.value = null
})
// A save is done once the popover's list has the view - closed then.
watch(() => props.saving, (now, before) => {
  if (before && !now) open.value = false
})
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ align: 'start' }"
  >
    <UTooltip :text="label">
      <UButton
        :icon="active ? 'i-lucide-bookmark-check' : 'i-lucide-bookmark'"
        :color="active ? 'primary' : 'neutral'"
        variant="outline"
        :aria-label="label"
        class="shrink-0"
      />
    </UTooltip>

    <template #content>
      <div class="flex w-80 flex-col gap-3 p-3">
        <template v-if="!saveFormOpen">
          <div class="flex max-h-96 flex-col gap-3 overflow-y-auto">
            <button
              type="button"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated"
              @click="select(null)"
            >
              <UIcon
                name="i-lucide-star"
                class="size-4 shrink-0 text-muted"
              />
              <span class="flex-1 truncate">{{ t('dataviews.savedViews.default') }}</span>
              <UIcon
                v-if="activeId === null"
                name="i-lucide-check"
                class="size-4 shrink-0 text-primary"
              />
            </button>

            <section
              v-if="mine.length"
              class="flex flex-col gap-0.5"
            >
              <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {{ t('dataviews.savedViews.mine') }}
              </p>
              <div
                v-for="view in mine"
                :key="view.id"
                class="flex items-center gap-1 rounded-md px-1 hover:bg-elevated"
              >
                <template v-if="removingId === view.id">
                  <span class="flex-1 truncate px-1 py-1.5 text-sm">{{ t('dataviews.savedViews.removeQuestion', { name: view.name }) }}</span>
                  <UButton
                    :label="t('common.cancel')"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    @click="removingId = null"
                  />
                  <UButton
                    :label="t('common.delete')"
                    size="xs"
                    color="error"
                    @click="emit('remove', view.id); removingId = null"
                  />
                </template>
                <template v-else>
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left text-sm"
                    @click="select(view.id)"
                  >
                    <span class="flex-1 truncate">{{ view.name }}</span>
                    <UIcon
                      v-if="view.id === activeId"
                      name="i-lucide-check"
                      class="size-4 shrink-0 text-primary"
                    />
                  </button>
                  <UTooltip :text="view.sharedCount > 0 ? t('dataviews.savedViews.sharedWith', { count: view.sharedCount }, view.sharedCount) : t('dataviews.savedViews.share')">
                    <UButton
                      icon="i-lucide-users"
                      size="xs"
                      :color="view.sharedCount > 0 ? 'primary' : 'neutral'"
                      variant="ghost"
                      :aria-label="t('dataviews.savedViews.share')"
                      @click="emit('share', view.id); open = false"
                    />
                  </UTooltip>
                  <UTooltip :text="t('dataviews.savedViews.delete')">
                    <UButton
                      icon="i-lucide-trash-2"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :aria-label="t('dataviews.savedViews.delete')"
                      @click="removingId = view.id"
                    />
                  </UTooltip>
                </template>
              </div>
            </section>

            <section
              v-if="shared.length"
              class="flex flex-col gap-0.5"
            >
              <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {{ t('dataviews.savedViews.sharedGroup') }}
              </p>
              <button
                v-for="view in shared"
                :key="view.id"
                type="button"
                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-elevated"
                @click="select(view.id)"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ view.name }}</span>
                  <span class="block truncate text-xs text-muted">{{ t('dataviews.savedViews.sharedBy', { name: view.ownerName ?? '' }) }}</span>
                </span>
                <UIcon
                  v-if="view.id === activeId"
                  name="i-lucide-check"
                  class="size-4 shrink-0 text-primary"
                />
              </button>
            </section>

            <section
              v-if="layouts.length > 1"
              class="flex flex-col gap-0.5"
            >
              <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {{ t('dataviews.savedViews.layouts') }}
              </p>
              <button
                v-for="layout in layouts"
                :key="layout.type"
                type="button"
                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated"
                @click="emit('layout', layout.type); open = false"
              >
                <UIcon
                  :name="layout.icon"
                  class="size-4 shrink-0 text-muted"
                />
                <span class="flex-1 truncate">{{ layout.label }}</span>
                <UIcon
                  v-if="layout.type === activeLayout"
                  name="i-lucide-check"
                  class="size-4 shrink-0 text-primary"
                />
              </button>
            </section>
          </div>

          <UButton
            :label="t('dataviews.savedViews.saveCurrent')"
            icon="i-lucide-bookmark-plus"
            color="neutral"
            variant="outline"
            block
            @click="saveFormOpen = true"
          />
        </template>

        <SaveViewForm
          v-else
          :views="views"
          :saving="saving"
          @save="emit('saveNew', $event)"
          @replace="emit('replace', $event)"
          @cancel="saveFormOpen = false"
        />
      </div>
    </template>
  </UPopover>
</template>
