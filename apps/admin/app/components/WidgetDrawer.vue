<script setup lang="ts">
/**
 * TDrawer - a page's drawer, TotalBase's own (Specification_DataViews.md §9):
 * AppDrawer, the drawer every admin screen uses - its title and
 * caption, Expand and Close, its widths - with the page's widgets in its Body
 * and Footer. Opened like a Modal: `dataview.controls.<name>.open()`.
 */
withDefaults(defineProps<{
  title?: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  expandable?: boolean
  startExpanded?: boolean
}>(), {
  title: '',
  description: undefined,
  size: 'lg',
  expandable: true,
  startExpanded: false
})
const open = defineModel<boolean>('open', { default: false })
defineSlots<{ body?: () => unknown, footer?: () => unknown }>()
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="title"
    :description="description"
    :size="size"
    :expandable="expandable"
    :start-expanded="startExpanded"
  >
    <div class="min-h-0 flex-1 overflow-y-auto">
      <slot name="body" />
    </div>
    <template
      v-if="$slots.footer"
      #footer
    >
      <slot name="footer" />
    </template>
  </AppDrawer>
</template>
