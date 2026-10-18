<script setup lang="ts">
/**
 * TotalBase's own mark (Specification_Admin_UI.md §4.1.1): a database cylinder with a T cut out of it, drawn in
 * `currentColor` so it takes the primary color, white over a panel, or whatever the parent sets. Shown wherever
 * the operator has set no `system.logo` (BrandMark, LoginBrand); the favicon is the same drawing in sky-600
 * (`public/favicon.ico`, `public/logo.svg`).
 */
/** `halo`: a soft shadow in the mark's own color under it (the rail). */
defineProps<{ label?: string, halo?: boolean }>()
</script>

<template>
  <svg
    viewBox="0 0 32 32"
    fill="currentColor"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
    :style="halo ? { filter: 'drop-shadow(0 2px 6px color-mix(in oklab, currentColor 40%, transparent))' } : undefined"
  >
    <path
      fill-rule="evenodd"
      d="M16 2c7.7 0 13 2.5 13 6v16c0 3.5-5.3 6-13 6S3 27.5 3 24V8c0-3.5 5.3-6 13-6Zm-7 7.5h14a1.5 1.5 0 0 0 0-3H9a1.5 1.5 0 0 0 0 3Zm5.5 2V24a1.5 1.5 0 0 0 3 0V11.5h-3Z"
    />
  </svg>
</template>
