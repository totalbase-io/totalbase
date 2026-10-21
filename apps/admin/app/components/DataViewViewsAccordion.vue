<script setup lang="ts">
/**
 * Settings > Views (DataViews.md §3.6, §5.13): a row per list view - several may be open at once.
 * The offered ones first, in the toolbar's order (dragged by their grip, or moved from their "⋮"), the rest below in
 * the canonical order (LIST_DATAVIEW_TYPES). Each row: its grip, icon and name, a badge (Main, Offered, Not offered,
 * Needs setup), the Offer switch and a "⋮" (Make main, move). Its content - the view's layout and its own controls -
 * is the page's (`#view`), on a tinted panel. On entering, only the main view is open.
 */
import { DATAVIEW_TYPE_META, LIST_DATAVIEW_TYPES, dataviewMetaKey, type DataViewType } from '~/types/dataview'
import { useCatalogText } from '~/utils/catalog-text'

const props = defineProps<{
  /** Whether the source's columns can show each view. */
  available: Partial<Record<DataViewType, boolean>>
  /** A view whose layout still misses a required piece. */
  invalid: Partial<Record<DataViewType, boolean>>
}>()
/** The views offered, in the toolbar's order - the main one among them. */
const layouts = defineModel<DataViewType[]>('layouts', { required: true })
/** The main view - the one it opens with (`view_type`). */
const mainView = defineModel<DataViewType>('mainView', { required: true })
defineSlots<{ view(props: { type: DataViewType, offered: boolean }): unknown }>()

const { t } = useI18n()
const catalogText = useCatalogText()
const label = (type: DataViewType) => catalogText(dataviewMetaKey('types', type, 'label'), DATAVIEW_TYPE_META[type].label)

const offered = computed(() => (layouts.value.length ? layouts.value : [mainView.value]))
/** The rows: the offered views in their order, then the others in the canonical one. */
const rows = computed(() => [...offered.value, ...LIST_DATAVIEW_TYPES.filter(type => !offered.value.includes(type))])
const isOffered = (type: DataViewType) => offered.value.includes(type)

const open = ref(new Set<DataViewType>([mainView.value]))
function toggle(type: DataViewType) {
  const next = new Set(open.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  open.value = next
}

function setOffered(type: DataViewType, on: boolean) {
  layouts.value = on ? [...offered.value, type] : offered.value.filter(other => other !== type)
  if (on) open.value = new Set([...open.value, type])
}
function makeMain(type: DataViewType) {
  if (!isOffered(type)) layouts.value = [...offered.value, type]
  mainView.value = type
}
function moveTo(type: DataViewType, index: number) {
  const next = offered.value.filter(other => other !== type)
  next.splice(Math.max(0, Math.min(next.length, index)), 0, type)
  layouts.value = next
}

/** A row's badge - what it needs first, then whether it's the main one, offered or not. */
function badge(type: DataViewType): { label: string, color: 'error' | 'primary' | 'success' | 'neutral' } {
  if (isOffered(type) && props.invalid[type]) return { label: t('designer.viewsAccordion.needsSetup'), color: 'error' }
  if (type === mainView.value) return { label: t('designer.viewsAccordion.main'), color: 'primary' }
  if (isOffered(type)) return { label: t('designer.viewsAccordion.offered'), color: 'success' }
  return { label: t('designer.viewsAccordion.notOffered'), color: 'neutral' }
}
function menu(type: DataViewType) {
  const index = offered.value.indexOf(type)
  return [[
    { label: t('designer.viewsAccordion.makeMain'), icon: 'i-lucide-house', disabled: type === mainView.value || (!isOffered(type) && !props.available[type]), onSelect: () => makeMain(type) },
    ...(isOffered(type)
      ? [
          { label: t('designer.viewsAccordion.moveUp'), icon: 'i-lucide-arrow-up', disabled: index === 0, onSelect: () => moveTo(type, index - 1) },
          { label: t('designer.viewsAccordion.moveDown'), icon: 'i-lucide-arrow-down', disabled: index === offered.value.length - 1, onSelect: () => moveTo(type, index + 1) }
        ]
      : [])
  ]]
}

// --- Dragging an offered view by its grip: its place in the toolbar --------------------------------------------
const dragging = ref<DataViewType | null>(null)
const over = ref<DataViewType | null>(null)
function onDragStart(event: DragEvent, type: DataViewType) {
  dragging.value = type
  event.dataTransfer?.setData('text/plain', type)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragOver(event: DragEvent, type: DataViewType) {
  if (!dragging.value || !isOffered(type) || type === dragging.value) return
  event.preventDefault()
  over.value = type
}
function onDrop(type: DataViewType) {
  if (dragging.value && isOffered(type)) moveTo(dragging.value, offered.value.indexOf(type))
  dragging.value = null
  over.value = null
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-for="type in rows"
      :key="type"
      class="rounded-md border"
      :class="[over === type ? 'border-primary' : 'border-default', !isOffered(type) ? 'opacity-70' : undefined, dragging === type ? 'opacity-40' : undefined]"
      @dragover="onDragOver($event, type)"
      @dragleave="over === type && (over = null)"
      @drop.prevent="onDrop(type)"
    >
      <div class="flex items-center gap-2 px-2 py-1.5">
        <UIcon
          name="i-lucide-grip-vertical"
          class="size-4 shrink-0 text-dimmed"
          :class="isOffered(type) && offered.length > 1 ? 'cursor-grab' : 'invisible'"
          :draggable="isOffered(type) && offered.length > 1"
          @dragstart="onDragStart($event, type)"
          @dragend="dragging = null; over = null"
        />
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :aria-expanded="open.has(type)"
          @click="toggle(type)"
        >
          <UIcon
            :name="open.has(type) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-4 shrink-0 text-muted"
          />
          <UIcon
            :name="DATAVIEW_TYPE_META[type].icon"
            class="size-4 shrink-0"
          />
          <span class="truncate text-sm font-medium">{{ label(type) }}</span>
        </button>
        <UBadge
          :label="badge(type).label"
          :color="badge(type).color"
          variant="subtle"
          size="sm"
        />
        <USwitch
          :model-value="isOffered(type)"
          :disabled="type === mainView || (!isOffered(type) && !available[type])"
          :aria-label="t('designer.viewsAccordion.offer', { view: label(type) })"
          @update:model-value="(on: boolean) => setOffered(type, on)"
        />
        <UDropdownMenu :items="menu(type)">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('designer.viewsAccordion.actions', { view: label(type) })"
          />
        </UDropdownMenu>
      </div>
      <div
        v-if="open.has(type)"
        class="m-2 mt-0 rounded-md border border-default bg-elevated/50 p-4"
      >
        <p
          v-if="!isOffered(type) && !available[type]"
          class="text-sm text-muted"
        >
          {{ t(`designer.layoutViews.unavailable.${type}`) }}
        </p>
        <p
          v-else-if="!isOffered(type)"
          class="text-sm text-muted"
        >
          {{ t('designer.layoutViews.turnOn') }}
        </p>
        <slot
          v-else
          name="view"
          :type="type"
          :offered="isOffered(type)"
        />
      </div>
    </div>
  </div>
</template>
