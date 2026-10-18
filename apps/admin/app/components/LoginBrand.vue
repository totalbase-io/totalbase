<script setup lang="ts">
/**
 * The company's mark on the sign-in page (Specification_Admin_UI.md §3.6, M29): its logo - else the built-in mark -
 * with its name at its right, and optionally its headline and intro below. Over a picture or the primary color (`inverse`) the texts
 * are white.
 */
withDefaults(defineProps<{
  /** Left-aligned (a side panel) or centered (above the card). */
  align?: 'start' | 'center'
  inverse?: boolean
  headline?: boolean
  intro?: boolean
}>(), { align: 'center', inverse: false, headline: false, intro: false })

const { instance } = useInstance()
</script>

<template>
  <div
    class="flex flex-col gap-3"
    :class="align === 'center' ? 'items-center text-center' : 'items-start text-start'"
  >
    <!-- The lockup: the mark with the name at its right, as the wordmark (brand/svg/wordmark.svg). -->
    <div class="flex items-center gap-3">
      <img
        v-if="instance.logoUrl"
        :src="instance.logoUrl"
        alt=""
        class="h-12 w-auto max-w-48 object-contain"
      >
      <TotalBaseMark
        v-else
        class="size-12 shrink-0"
        :class="inverse ? 'text-white' : 'text-primary'"
      />
      <h1
        class="text-3xl font-bold tracking-tight"
        :class="inverse ? 'text-white' : 'text-highlighted'"
      >
        {{ instance.name }}
      </h1>
    </div>
    <p
      v-if="headline && instance.login.headline"
      class="max-w-md text-lg"
      :class="inverse ? 'text-white/90' : 'text-muted'"
    >
      {{ instance.login.headline }}
    </p>
    <p
      v-if="intro && instance.login.intro"
      class="max-w-md"
      :class="inverse ? 'text-white/75' : 'text-muted'"
    >
      {{ instance.login.intro }}
    </p>
  </div>
</template>
