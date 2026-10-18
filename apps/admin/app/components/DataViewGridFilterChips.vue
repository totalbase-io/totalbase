<script setup lang="ts">
/**
 * The chip rows under DataViewGrid.vue's toolbar: a link's filter (`?filter=`,
 * a dashboard's click - shown and removable whether or not the viewer may
 * filter) and, on the standalone page, the viewer's own active filter - the
 * same where-grammar chips WhereField.vue's own Filter panel shows below its
 * JSON editor, surfaced here too so a filter stays visible/removable without
 * reopening that slideover. A group too complex to break apart (a nested
 * group written by hand) falls back to one generic chip that clears the
 * whole thing.
 */
import type { Condition, ConditionGroup } from '~/utils/filterConditions'

defineProps<{
  /** The link's filter as chips - null without a link filter; a group with no conditions is the generic chip. */
  linkGroup: ConditionGroup | null
  /** There is a link filter (even one too complex for chips). */
  hasLinkFilter: boolean
  /** A link condition's text - by the column's title, a foreign key by its row's presentation. */
  linkChipText: (condition: Condition) => string
  /** The viewer's own active filter shows (standalone, Filter on, something typed). */
  showFilter: boolean
  /** The viewer's filter as chips - null: too complex, one generic chip. */
  filterConditions: Condition[] | null
  /** A filter condition's text - by the column's title, as the link's (linkChipText). */
  filterChipText: (condition: Condition) => string
}>()
const emit = defineEmits<{
  removeLink: [index: number]
  clearLink: []
  removeFilter: [index: number]
  clearFilter: []
}>()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="hasLinkFilter"
    class="flex flex-wrap items-center gap-1.5"
  >
    <UIcon
      name="i-lucide-link"
      class="size-3.5 text-muted"
      :aria-label="t('dataviews.grid.linkFilter')"
    />
    <template v-if="linkGroup">
      <UBadge
        v-for="(condition, index) in linkGroup.conditions"
        :key="index"
        color="primary"
        variant="subtle"
      >
        {{ linkChipText(condition) }}
        <UButton
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="link"
          class="p-0 ml-1"
          :aria-label="t('dataviews.grid.removeLinkFilter')"
          @click="emit('removeLink', index)"
        />
      </UBadge>
    </template>
    <UBadge
      v-else
      color="primary"
      variant="subtle"
    >
      {{ t('dataviews.grid.linkFilter') }}
      <UButton
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="link"
        class="p-0 ml-1"
        :aria-label="t('dataviews.grid.removeLinkFilter')"
        @click="emit('clearLink')"
      />
    </UBadge>
  </div>
  <div
    v-if="showFilter"
    class="flex flex-wrap items-center gap-1.5"
  >
    <template v-if="filterConditions">
      <UBadge
        v-for="(condition, index) in filterConditions"
        :key="index"
        color="neutral"
        variant="subtle"
      >
        {{ filterChipText(condition) }}
        <UButton
          :aria-label="t('common.remove')"
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="link"
          class="p-0 ml-1"
          @click="emit('removeFilter', index)"
        />
      </UBadge>
    </template>
    <UBadge
      v-else
      color="neutral"
      variant="subtle"
    >
      {{ t('dataviews.grid.activeFilter') }}
      <UButton
        :aria-label="t('common.clear')"
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="link"
        class="p-0 ml-1"
        @click="emit('clearFilter')"
      />
    </UBadge>
  </div>
</template>
