<script setup lang="ts">
/** One box of a TREE DataView's org chart (DataViewTreeView.vue) and, under it, its children's. */
import type { TreeNode } from './TreeView.vue'
import type { TreeItem } from './DataViewTreeView.vue'

const props = defineProps<{
  node: TreeNode<TreeItem>
  canCreate: boolean
  swatch: (color: string | null) => string | undefined
  depth?: number
}>()
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'add-child': [node: TreeNode<TreeItem>]
}>()
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
      class="flex w-52 flex-col items-center gap-1 rounded-md border border-default bg-default px-3 py-2 text-center"
      :style="color ? { borderTopColor: color, borderTopWidth: '3px' } : undefined"
    >
      <button
        type="button"
        class="flex w-full flex-col items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-primary"
        @click="emit('edit', node.data.row)"
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
        v-if="kids.length > 0 || canCreate"
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
          v-if="canCreate"
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('dataviews.treeView.addChild', { name: node.data.title })"
          @click="emit('add-child', node)"
        />
      </div>
    </div>
    <ul
      v-if="kids.length > 0 && open"
      role="group"
    >
      <DataViewTreeOrgNode
        v-for="child in kids"
        :key="child.id"
        v-model:collapsed="collapsed"
        :node="child"
        :can-create="canCreate"
        :swatch="swatch"
        :depth="(depth ?? 0) + 1"
        @edit="emit('edit', $event)"
        @add-child="emit('add-child', $event)"
      />
    </ul>
  </li>
</template>
