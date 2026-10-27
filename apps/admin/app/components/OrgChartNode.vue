<script lang="ts">
/** What a box shows. */
</script>

<script setup lang="ts" generic="D extends OrgChartItem">
/** One box of an org chart (OrgChart.vue) and, under it, its children's. */
import type { TreeNode } from './TreeView.vue'

export interface OrgChartItem {
  title: string
  description: string
  icon: string | null
  color: string | null
  /** null: no image; '' while it loads or when there's none - the avatar shows its initials. */
  image: string | null
  /** The box the chart is about (a role's own, on its Hierarchy) - outlined. */
  current?: boolean
  /** Shown dimmed (an inactive role). */
  muted?: boolean
}

const props = defineProps<{
  node: TreeNode<D>
  /** The "+" under a box, with its accessible name - none (or undefined for this box): no "+". */
  addLabel?: (node: TreeNode<D>) => string | undefined
  swatch: (color: string | null) => string | undefined
  depth?: number
  /** Dragging (OrgChart.vue's `canDrag`/`canDrop`): this box may be dragged, the one dragged dropped on it. */
  canDrag?: (node: TreeNode<D>) => boolean
  canDrop?: (draggedId: string, target: TreeNode<D>) => boolean
  dragged?: string | null
}>()
const emit = defineEmits<{
  'open': [node: TreeNode<D>]
  'add-child': [node: TreeNode<D>]
  'drag-start': [id: string]
  'drag-end': []
  'drop': [target: TreeNode<D>]
}>()
const addText = computed(() => props.addLabel?.(props.node))
const draggable = computed(() => props.canDrag?.(props.node) ?? false)
const droppable = computed(() => !!props.dragged && props.dragged !== props.node.id && (props.canDrop?.(props.dragged, props.node) ?? false))
const over = ref(false)
function onDragStart(event: DragEvent) {
  event.dataTransfer?.setData('text/plain', props.node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('drag-start', props.node.id)
}
function onDragOver(event: DragEvent) {
  if (!droppable.value) return
  event.preventDefault()
  over.value = true
}
function onDrop(event: DragEvent) {
  over.value = false
  if (!droppable.value) return
  event.preventDefault()
  emit('drop', props.node)
}
const collapsed = defineModel<string[]>('collapsed', { required: true })

const { t } = useI18n()
// Resolved here, where a shown node renders: a deferred file image is fetched only for the nodes on the page.
const { resolveFileSrc } = useFileObjectUrl()
const open = computed(() => !collapsed.value.includes(props.node.id))
const kids = computed(() => props.node.children ?? [])
function toggle() {
  collapsed.value = open.value ? [...collapsed.value, props.node.id] : collapsed.value.filter(id => id !== props.node.id)
}
const color = computed(() => props.swatch(props.node.data.color))
const avatar = computed(() => {
  if (props.node.data.image !== null) return { src: resolveFileSrc(props.node.data.image), alt: props.node.data.title }
  if (props.node.data.icon) return { icon: props.node.data.icon, style: color.value ? { color: color.value } : undefined }
  return undefined
})
</script>

<template>
  <li
    role="treeitem"
    :aria-level="(depth ?? 0) + 1"
    :aria-expanded="kids.length > 0 ? open : undefined"
  >
    <div
      class="flex w-52 flex-col items-center gap-1 rounded-md border bg-default px-3 py-2 text-center"
      :class="[
        node.data.current || over ? 'border-primary ring-1 ring-primary' : 'border-default',
        node.data.muted && 'opacity-60',
        draggable && 'cursor-move',
        dragged === node.id && 'opacity-40'
      ]"
      :style="color ? { borderTopColor: color, borderTopWidth: '3px' } : undefined"
      :aria-current="node.data.current ? 'true' : undefined"
      :draggable="draggable ? 'true' : undefined"
      @dragstart="onDragStart"
      @dragend="emit('drag-end')"
      @dragover="onDragOver"
      @dragleave="over = false"
      @drop="onDrop"
    >
      <button
        type="button"
        class="flex w-full flex-col items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-primary"
        @click="emit('open', node)"
      >
        <!-- UUser: a photo, else the name's initials; an icon when there's no image formula but an icon one. -->
        <UUser
          :name="node.data.title"
          :description="node.data.description || undefined"
          :avatar="avatar"
          orientation="vertical"
          size="lg"
          class="w-full items-center text-center"
          :ui="{ wrapper: 'min-w-0 w-full', name: 'line-clamp-2 whitespace-normal', description: 'line-clamp-2 whitespace-normal' }"
        />
      </button>
      <div
        v-if="kids.length > 0 || addText"
        class="flex items-center gap-1"
      >
        <UButton
          v-if="kids.length > 0"
          :icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :label="String(kids.length)"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="open ? t('common.collapse') : t('common.expand')"
          @click="toggle"
        />
        <UButton
          v-if="addText"
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="addText"
          @click="emit('add-child', node)"
        />
      </div>
    </div>
    <ul
      v-if="kids.length > 0 && open"
      role="group"
    >
      <OrgChartNode
        v-for="child in kids"
        :key="child.id"
        v-model:collapsed="collapsed"
        :node="child"
        :add-label="addLabel"
        :swatch="swatch"
        :depth="(depth ?? 0) + 1"
        :can-drag="canDrag"
        :can-drop="canDrop"
        :dragged="dragged"
        @open="emit('open', $event)"
        @add-child="emit('add-child', $event)"
        @drag-start="emit('drag-start', $event)"
        @drag-end="emit('drag-end')"
        @drop="emit('drop', $event)"
      />
    </ul>
  </li>
</template>
