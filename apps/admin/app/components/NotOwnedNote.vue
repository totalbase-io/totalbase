<script setup lang="ts">
/**
 * The reason a table's, view's or function's structure can't be edited
 * here (Specification_Administration.md §3.15): the configured PostgreSQL
 * role neither owns it nor belongs to its owner role. Editing controls are
 * disabled beside it; PostgreSQL still decides every statement.
 */
defineProps<{ kind: 'table' | 'view' | 'function', owner: string }>()
</script>

<template>
  <p
    class="flex items-start gap-2 text-sm text-muted"
    data-testid="not-owned-note"
  >
    <UIcon
      name="i-lucide-lock"
      class="size-4 shrink-0 mt-0.5"
    />
    <i18n-t
      :keypath="`shell.notOwnedNote.${kind}`"
      tag="span"
    >
      <template #owner>
        <span class="font-mono text-default">{{ owner }}</span>
      </template>
    </i18n-t>
  </p>
</template>
