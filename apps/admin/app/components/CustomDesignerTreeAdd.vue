<script setup lang="ts">
/** The Structure tree's "+": the catalog, with its search, placing a widget at the end of an area. */
import type { WidgetName } from '@totalbase/tb-catalog'
import { CUSTOM_DESIGNER_TREE_KEY, type TreeAreaNode } from '~/composables/useCustomDesignerTree'
import CustomDesignerPalette from '~/components/CustomDesignerPalette.vue'

const props = defineProps<{ node: TreeAreaNode }>()
const tree = inject(CUSTOM_DESIGNER_TREE_KEY)!
const { t } = useI18n()
const open = computed({
  get: () => tree.adding.value === props.node.key,
  set: (value: boolean) => { tree.adding.value = value ? props.node.key : null }
})
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ side: 'right', align: 'start' }"
  >
    <UButton
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      :aria-label="t('designer.customDesignerTree.addIn', { area: node.label })"
      @click.stop
    />
    <template #content>
      <div class="max-h-96 w-64 overflow-y-auto p-2">
        <CustomDesignerPalette
          :draggable="false"
          @place="(widget: WidgetName) => tree.placeIn(node, widget)"
        />
      </div>
    </template>
  </UPopover>
</template>
