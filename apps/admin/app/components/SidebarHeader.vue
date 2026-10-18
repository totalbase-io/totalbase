<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
  icon?: string
}>()
</script>

<template>
  <header class="sidebar-header">
    <div class="header-icon">
      <UIcon
        :name="icon ?? 'i-lucide-panel-left'"
        class="header-icon__glyph"
      />
    </div>
    <div class="min-w-0">
      <p class="header-title truncate">
        {{ title }}
      </p>
      <p
        v-if="subtitle"
        class="header-subtitle truncate"
      >
        {{ subtitle }}
      </p>
    </div>
    <slot />
  </header>
</template>
