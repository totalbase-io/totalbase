<script setup lang="ts">
/** TText (WIDGET_CATALOG) - a paragraph whose content can be a formula. TotalBase's own widget. */
defineProps<{ label?: string }>()
</script>

<template>
  <p class="text-sm text-default whitespace-pre-line">
    {{ label }}
  </p>
</template>
