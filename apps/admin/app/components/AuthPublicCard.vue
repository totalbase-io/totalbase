<script setup lang="ts">
/** The frame for the public pages a system email's link opens (pages/auth/*): the product mark above one small centered card, the language and color mode switches at the corner. */
</script>

<template>
  <div class="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-default px-4 py-12">
    <div class="absolute top-3 right-3 flex items-center gap-1">
      <LanguageButton />
      <UColorModeButton />
    </div>
    <BrandMark />
    <div class="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-default bg-default p-6 shadow-sm">
      <slot />
    </div>
  </div>
</template>
