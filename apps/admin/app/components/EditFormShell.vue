<script setup lang="ts">
/**
 * Picks the actual container for a `TABLE`/`CARDS` DataView's Edit form
 * based on its `view_config.edit_presentation` (Specification_DataViews.md §6.3)
 * - `AppDrawer`/`UModal`/`USlideover`, all
 * three already in real use elsewhere in the admin, none new. Kept as
 * its own component (rather than three v-if blocks inline in
 * DataViewRecordPanel.vue) so the field-rendering body isn't duplicated
 * three times over - callers just pass `presentation` and their content
 * through the default/`actions`/`footer` slots, same shape either way:
 * `actions` in the container's header, `footer` pinned under the body
 * (AGENTS.md section 25, record forms).
 *
 * `PAGE` is deliberately excluded from the type here - it isn't an
 * overlay at all (DataViewGrid.vue navigates to a dedicated route for
 * it instead, never mounting this component), so there's no container
 * to pick for it.
 *
 * `size`/`side` (`view_config.edit_size`/`edit_side`) let the DataView's
 * own author size/position that container - see types/dataview.ts's
 * `EditSize`/`EditSide` doc comments for exactly what each maps to per
 * presentation (`side` only does anything for SIDEBAR).
 */
import type { EditPresentation, EditSide, FormSize } from '~/types/dataview'

withDefaults(defineProps<{
  presentation: Exclude<EditPresentation, 'PAGE'>
  title: string
  description?: string
  /** DRAWER/MODAL/SIDEBAR only - see types/dataview.ts's `EditSize` doc comment for how each presentation maps this to something different underneath. */
  size?: FormSize
  /** SIDEBAR only - which side USlideover slides in from. Ignored for DRAWER/MODAL. */
  side?: EditSide
}>(), {
  size: 'default',
  side: 'right'
})
const open = defineModel<boolean>('open', { required: true })
/** A record form is an editor: fullscreen on a phone or a tablet, whatever its size (AGENTS.md section 25). */
const isCompact = useCompactUi()

// Neither UModal nor USlideover has a discrete `size` prop of its own,
// unlike AppDrawer which does - so their sizing is a `:ui.content`
// max-width (utils/overlay-size.ts's EDIT_FORM_WIDTH); `default`, none chosen,
// leaves each component at its own Nuxt UI width.
</script>

<template>
  <AppDrawer
    v-if="presentation === 'DRAWER'"
    v-model:open="open"
    :title="title"
    :description="description"
    :size="size"
    close-on-escape
  >
    <!-- `actions`: the record's other actions, in each container's own header (RecordHeaderActions.vue). -->
    <template
      v-if="$slots.actions"
      #header-actions
    >
      <slot name="actions" />
    </template>
    <slot />
    <template
      v-if="$slots.footer"
      #footer
    >
      <slot name="footer" />
    </template>
  </AppDrawer>

  <UModal
    v-else-if="presentation === 'MODAL'"
    v-model:open="open"
    :title="title"
    :description="description"
    :fullscreen="isCompact"
    :ui="EDIT_FORM_WIDTH[size] ? { content: EDIT_FORM_WIDTH[size] } : undefined"
  >
    <template
      v-if="$slots.actions"
      #actions
    >
      <slot name="actions" />
    </template>
    <template #body>
      <slot />
    </template>
    <template
      v-if="$slots.footer"
      #footer
    >
      <slot name="footer" />
    </template>
  </UModal>

  <USlideover
    v-else
    v-model:open="open"
    :title="title"
    :description="description"
    :side="side"
    :ui="EDIT_FORM_WIDTH[size] ? { content: EDIT_FORM_WIDTH[size] } : undefined"
  >
    <template
      v-if="$slots.actions"
      #actions
    >
      <slot name="actions" />
    </template>
    <template #body>
      <slot />
    </template>
    <template
      v-if="$slots.footer"
      #footer
    >
      <slot name="footer" />
    </template>
  </USlideover>
</template>
