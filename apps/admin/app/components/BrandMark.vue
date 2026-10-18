<script setup lang="ts">
/**
 * The product mark (Specification_Admin_UI.md §4.1.1): the operator's logo
 * (`system.logo`) at the mark's height, width to fit, else TotalBase's own
 * mark (`TotalBaseMark.vue`) in the primary color - with the instance's name beside it unless
 * `iconOnly` (the rail). One component, so the rail, the sign-in page and
 * the public auth pages can't drift apart.
 */
const props = withDefaults(defineProps<{
  iconOnly?: boolean
  /** A soft shadow in the primary color under the built-in mark. */
  halo?: boolean
  /** Text size of the name; the mark follows. */
  size?: 'sm' | 'md' | 'lg'
}>(), { iconOnly: false, halo: false, size: 'md' })

const { instance } = useInstance()
const markClass = computed(() => ({ sm: 'h-5', md: 'h-6', lg: 'h-8' })[props.size])
const nameClass = computed(() => ({ sm: 'text-sm font-semibold', md: 'font-semibold', lg: 'text-lg font-bold' })[props.size])
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-2">
    <img
      v-if="instance.logoUrl"
      :src="instance.logoUrl"
      :alt="iconOnly ? instance.name : ''"
      class="w-auto shrink-0 object-contain"
      :class="[markClass, iconOnly ? 'max-w-10' : 'max-w-32']"
    >
    <TotalBaseMark
      v-else
      class="shrink-0 text-primary"
      :class="markClass.replace('h-', 'size-')"
      :label="iconOnly ? instance.name : undefined"
      :halo="halo"
    />
    <span
      v-if="!iconOnly"
      class="truncate text-highlighted"
      :class="nameClass"
    >{{ instance.name }}</span>
  </span>
</template>
