<script setup lang="ts">
/**
 * Single page behind the Database rail group now (replaces the old
 * tables.vue/views.vue/functions.vue trio). DatabaseTree.vue (the group's
 * own nav panel, rendered by layouts/default.vue's aside - a layout
 * sibling of this page, not a parent) writes selections into
 * useDatabaseSelection()'s shared state; this page reads them and drives
 * ResourcesBrowser's `type`/`schema` v-models, opening its drawer directly
 * on a leaf click via the exposed openDetail().
 *
 * Landing state (nothing picked in the tree yet, `selection.touched` still
 * false): a plain "Resources" empty state instead of defaulting to
 * ResourcesBrowser's full table list - entering /resources with no
 * selection used to silently show every table, which read as this page's
 * real content rather than a placeholder. TABLE leaves never reach this
 * page at all (they navigate straight to their own detail route); a
 * category click or a VIEW/FUNCTION leaf sets `touched: true` and swaps
 * this landing for ResourcesBrowser's filtered list, same as before.
 */
const selection = useDatabaseSelection()
const { t } = useI18n()
const type = ref(selection.value.type)
const schema = ref(selection.value.schema)
const browser = useTemplateRef('browser')

watch(selection, (sel) => {
  type.value = sel.type
  schema.value = sel.schema
  if (sel.openResource) browser.value?.openDetail(sel.openResource)
})
</script>

<template>
  <div
    v-if="!selection.touched"
    class="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
  >
    <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
      <UIcon
        name="i-lucide-database"
        class="size-5 text-muted"
      />
    </div>
    <h1 class="mt-4 text-base font-semibold text-highlighted">
      {{ t('database.resourcesIndex.title') }}
    </h1>
    <p class="mt-1 max-w-sm text-sm text-muted">
      {{ t('database.resourcesIndex.description') }}
    </p>
  </div>
  <ResourcesBrowser
    v-else
    ref="browser"
    v-model:type="type"
    v-model:schema="schema"
  />
</template>
