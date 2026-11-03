<script setup lang="ts">
/**
 * The standalone App menu's head (Admin_UI.md §3.1.1): the instance's logo
 * and name as `app.menu_header` says - both, one of them, or nothing - as a
 * link to the App; whatever the layout puts beside it (the collapse button,
 * a phone's Close) goes in the slot.
 */
import type { MenuHeader } from '~/types/app-menu'

defineProps<{ header: MenuHeader }>()
const { instance } = useInstance()
</script>

<template>
  <header class="sidebar-header">
    <NuxtLink
      v-if="header !== 'NONE'"
      to="/app"
      :aria-label="instance.name"
      class="flex min-w-0 items-center"
    >
      <BrandMark
        :icon-only="header === 'LOGO'"
        :name-only="header === 'NAME'"
      />
    </NuxtLink>
    <slot />
  </header>
</template>
