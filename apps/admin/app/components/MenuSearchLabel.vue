<script setup lang="ts">
/** A menu entry's label with what the search matched marked (AppMenuPanel.vue, Security.md §8.2). */
import { highlightParts } from '~/utils/menu-search'

const props = defineProps<{ text: string, term: string }>()
const parts = computed(() => highlightParts(props.text, props.term))
</script>

<template>
  <template
    v-for="(part, index) in parts"
    :key="index"
  >
    <mark
      v-if="part.match"
      class="rounded-sm bg-primary/20 text-inherit"
    >{{ part.text }}</mark>
    <template v-else>
      {{ part.text }}
    </template>
  </template>
</template>
