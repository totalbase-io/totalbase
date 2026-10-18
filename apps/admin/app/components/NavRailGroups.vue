<script setup lang="ts">
/**
 * The rail's group buttons, shared by the desktop rail and the mobile
 * navigation slideover (layouts/default.vue) - icons with a tooltip.
 */
const props = defineProps<{
  groups: AdminNavGroup[]
  activeKey: string
  isAdmin: boolean
}>()
const emit = defineEmits<{ select: [key: string] }>()

// Separators before the first group of each block of the admin rail.
const SEPARATED_GROUPS = ['database', 'dataviews', 'files', 'users', 'logs']
const separatedBefore = (key: string) => props.isAdmin && SEPARATED_GROUPS.includes(key)
</script>

<template>
  <template
    v-for="group in groups"
    :key="group.key"
  >
    <USeparator
      v-if="separatedBefore(group.key)"
      class="my-1 w-8"
    />
    <UTooltip
      :text="group.label"
      :content="{ side: 'right' }"
    >
      <UButton
        :icon="group.icon"
        :color="activeKey === group.key ? 'primary' : 'neutral'"
        :variant="activeKey === group.key ? 'subtle' : 'ghost'"
        size="lg"
        square
        :aria-label="group.label"
        @click="emit('select', group.key)"
      />
    </UTooltip>
  </template>
</template>
