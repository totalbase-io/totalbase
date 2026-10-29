<script setup lang="ts">
/**
 * The rail and the panel's part of the shell (layouts/default.vue). In midnight (useColorModeChoice) it is dark:
 * Nuxt UI's tokens and Tailwind's `dark:` follow a `.dark` ancestor, so everything inside reads dark - the
 * operator's `.dark [data-shell="…"]` rules too - while the page stays light; the opaque background keeps the
 * rail's and the panel's translucent ones over dark. Its tone goes down to what picks colors in script
 * (useSurfaceTone). Overlays opened from inside are teleported to <body>, and stay light.
 */
const colorMode = useColorMode()
const midnight = computed(() => colorMode.value === 'midnight')
provide(SURFACE_TONE, computed(() => (midnight.value || colorMode.value === 'dark' ? 'dark' : 'light')))
</script>

<template>
  <div :class="midnight ? 'dark bg-default' : undefined">
    <slot />
  </div>
</template>
