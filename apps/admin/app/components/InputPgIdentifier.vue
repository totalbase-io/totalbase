<script setup lang="ts">
/**
 * Drop-in UInput for any Postgres identifier field (table/schema/column/
 * constraint/index name) - sanitizes as the user types via sanitizePgIdentifier
 * (app/utils/pgIdentifier.ts) so invalid characters never land in the field
 * at all, rather than surfacing as a toast only after a failed create/rename.
 * Server-side validateIdentifier (packages/schema) remains authoritative -
 * this is convenience-only, same tradeoff as slugify.ts / NameSlugFields.vue.
 *
 * Everything else (placeholder, autofocus, class, size, disabled, ...) just
 * passes through to the underlying UInput via attrs fallthrough.
 */
defineOptions({ inheritAttrs: false })

const model = defineModel<string>({
  default: '',
  set: (value: string) => sanitizePgIdentifier(value)
})
</script>

<template>
  <UInput
    v-model="model"
    v-bind="$attrs"
  />
</template>
