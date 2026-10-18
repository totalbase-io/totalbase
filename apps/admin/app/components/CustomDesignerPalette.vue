<script setup lang="ts">
/**
 * The Design form's palette: the widget catalog by group, searchable. A
 * click places a widget at the end of the area in view; on a desktop it
 * can also be dragged onto the canvas. Rendered in the designer's left
 * panel, and on a phone or a tablet in the "Add widget" slideover - there
 * with each widget's description under its name, since a tooltip needs a
 * pointer.
 */
import { WIDGET_NAMES, widgetDefinition, type WidgetGroup, type WidgetName } from '@totalbase/tb-catalog'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

const props = defineProps<{
  /** A desktop: drag onto the canvas; tooltips carry the descriptions. */
  draggable: boolean
}>()
const emit = defineEmits<{
  place: [name: WidgetName]
  dragstart: [event: DragEvent, name: WidgetName]
  dragend: []
}>()

const { t } = useI18n()
const cat = useDesignerCatalogText()
const label = (name: WidgetName) => cat.widgetLabel(name, widgetDefinition(name).label)
const description = (name: WidgetName) => cat.widgetDescription(name, widgetDefinition(name).description)

const GROUPS: { key: WidgetGroup, label: string }[] = [
  { key: 'form', label: 'Form' },
  { key: 'input', label: 'Inputs' },
  { key: 'display', label: 'Display' },
  { key: 'embed', label: 'Embed' },
  { key: 'container', label: 'Layout' },
  { key: 'overlay', label: 'Overlays' },
  { key: 'action', label: 'Actions' }
]
const search = ref('')
const groups = computed(() => {
  const term = search.value.trim().toLowerCase()
  return GROUPS.map(group => ({
    ...group,
    label: cat.groupLabel(group.key, group.label),
    items: WIDGET_NAMES.filter((name) => {
      const entry = widgetDefinition(name)
      if (entry.group !== group.key) return false
      return !term || [name, entry.label, entry.description, label(name), description(name)].some(text => text.toLowerCase().includes(term))
    })
  })).filter(group => group.items.length > 0)
})
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-3">
    <UInput
      v-model="search"
      :aria-label="t('designer.palette.search')"
      icon="i-lucide-search"
      :placeholder="t('designer.palette.search')"
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
        v-for="name in group.items"
        :key="name"
        :text="description(name)"
        :disabled="!props.draggable"
        :content="{ side: 'right' }"
      >
        <button
          type="button"
          class="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated"
          :draggable="props.draggable"
          @click="emit('place', name)"
          @dragstart="emit('dragstart', $event, name)"
          @dragend="emit('dragend')"
        >
          <UIcon
            :name="widgetDefinition(name).icon"
            class="mt-0.5 size-4 shrink-0 text-muted"
          />
          <span class="min-w-0">
            <span class="block truncate">{{ label(name) }}</span>
            <span
              v-if="!props.draggable"
              class="block text-xs text-muted"
            >{{ description(name) }}</span>
          </span>
        </button>
      </UTooltip>
    </div>
  </div>
</template>
