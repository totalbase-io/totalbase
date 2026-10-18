<script setup lang="ts">
/**
 * The editor header's versions chip - shared by the Dashboards, Workflows
 * and DataViews editors (Specification.md §13.7). Shows
 * "Draft" or "Viewing vN"; the menu (useVersionMenu.ts) lists every
 * version plus "Draft" to leave a preview. Purely presentational: the
 * host loads versions and decides what opening one means.
 *
 * Desktop only - on a phone the host passes useVersionMenu's
 * `mobileMenu` to PageHeader's `mobile-menu` instead.
 */
import type { VersionSummary } from '~/types/versioning'

const props = defineProps<{
  versions: VersionSummary[]
  /** The version being previewed read-only, or null when the draft is shown. */
  viewing: number | null
}>()
const emit = defineEmits<{ 'select': [version: number | null], 'delete-old': [] }>()

// Phone-style on a phone or a tablet, like the app shell (useCompactUi).
const isCompact = useCompactUi()
const { t } = useI18n()
const { items, liveVersion, title, subtitle } = useVersionMenu(() => props.versions, () => props.viewing, version => emit('select', version), () => emit('delete-old'))
</script>

<template>
  <UDropdownMenu
    v-if="!isCompact"
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      icon="i-lucide-git-commit-vertical"
      color="neutral"
      variant="outline"
    >
      <div class="flex flex-col items-start leading-tight">
        <span>{{ title }}</span>
        <span class="text-xs text-dimmed">{{ subtitle }}</span>
      </div>
    </UButton>
    <template #active-trailing>
      <span class="ms-auto inline-flex items-center gap-1.5">
        <UBadge
          :label="t('common.active')"
          color="success"
          variant="subtle"
          size="sm"
        />
        <UIcon
          v-if="viewing !== null && viewing === liveVersion"
          name="i-lucide-check"
          class="size-4 shrink-0"
        />
      </span>
    </template>
  </UDropdownMenu>
</template>
