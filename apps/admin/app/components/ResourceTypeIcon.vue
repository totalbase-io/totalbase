<script setup lang="ts">
import type { ResourceType } from '~/types/resource'

defineProps<{ type: ResourceType }>()
</script>

<template>
  <span
    class="inline-flex items-center justify-center size-7 rounded-full shrink-0"
    :class="RESOURCE_TYPE_STYLE[type].wrap"
  >
    <UIcon
      :name="RESOURCE_TYPE_STYLE[type].icon"
      class="size-4"
    />
  </span>
</template>
