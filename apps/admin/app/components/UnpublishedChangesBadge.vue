<script setup lang="ts">
/**
 * The editor header's "Unpublished changes" badge - shared by the
 * Dashboards, Workflows and DataViews editors (Specification.md §13.7).
 * Same height as the header buttons (`page-header__tall`), two centered lines so it
 * stays narrow. `inline`: one line, the height of a size-sm button - for a
 * header with room to spare (DataViewPreviewDrawer.vue). Saving itself is
 * shown by SaveStatus.vue (autosave). Hidden on a phone, where the header
 * has no room for it - an enabled Publish button already says there is
 * something to publish.
 */
withDefaults(defineProps<{ inline?: boolean }>(), { inline: false })
</script>

<template>
  <UBadge
    v-if="inline"
    color="warning"
    variant="subtle"
    :label="$t('common.unpublishedChanges')"
    class="h-8 whitespace-nowrap px-2.5 max-md:hidden"
  />
  <UBadge
    v-else
    color="warning"
    variant="subtle"
    class="page-header__tall flex-col justify-center gap-0 px-2.5 text-center leading-tight max-md:hidden"
  >
    <span>{{ $t('shell.unpublishedBadge.line1') }}</span>
    <span>{{ $t('shell.unpublishedBadge.line2') }}</span>
  </UBadge>
</template>
