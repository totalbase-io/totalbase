<script setup lang="ts">
/**
 * The Design canvas's toolbar (CustomDesigner.vue). Left, where you are:
 * the palette's fold button and the breadcrumb of the area in view. Right,
 * what you do here, in groups: how the canvas shows (the hidden-widgets
 * switch, how the form opens), the 1-4 columns layout with its Undo
 * (desktop only - a phone or a tablet edits content, not layout), what to
 * add ("Add widget" - the palette as a sheet, on a phone or a tablet -,
 * "Add fields…" on a page with a record), and the inspector's fold button.
 */
import type { BreadcrumbItem } from '@nuxt/ui'
import { COLUMN_LAYOUTS } from '~/utils/widget-layout'

defineProps<{
  /** A phone or a tablet (useCompactUi): no panels to fold, no layout tools; the palette opens over the page. */
  compact: boolean
  paletteCollapsed: boolean
  inspectorCollapsed: boolean
  breadcrumb: BreadcrumbItem[]
  /** The width every laid-out widget shares, if they share one - its button shows as the current layout. */
  currentWidth: number | null
  /** Nothing in view to lay out. */
  layoutDisabled: boolean
  canUndoColumns: boolean
  /** The page has a record table - its columns can be added as fields. */
  hasRecord: boolean
}>()
const emit = defineEmits<{
  togglePalette: []
  toggleInspector: []
  applyColumns: [width: number]
  undoColumns: []
  addWidget: []
  addFields: []
}>()
/** Widgets hidden by a formula drawn faded and labeled on the canvas - the toolbar's switch, remembered on this device. */
const markHidden = defineModel<boolean>('markHidden', { default: true })
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <!-- Where you are. -->
    <div class="flex min-w-0 items-center gap-2">
      <UTooltip
        v-if="!compact"
        :text="paletteCollapsed ? t('designer.customDesigner.showWidgets') : t('designer.customDesigner.hideWidgets')"
      >
        <UButton
          :icon="paletteCollapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
          :aria-label="paletteCollapsed ? t('designer.customDesigner.showWidgets') : t('designer.customDesigner.hideWidgets')"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="emit('togglePalette')"
        />
      </UTooltip>
      <UBreadcrumb :items="breadcrumb" />
    </div>

    <!-- What you do here. -->
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2">
        <!-- Hidden widgets (a Visible formula, or Visible off): faded and labeled, or as the App draws them when shown. -->
        <UTooltip :text="markHidden ? t('designer.customDesigner.hiddenMarked') : t('designer.customDesigner.hiddenAsApp')">
          <UButton
            :icon="markHidden ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            :aria-label="markHidden ? t('designer.customDesigner.hiddenMarked') : t('designer.customDesigner.hiddenAsApp')"
            :aria-pressed="markHidden"
            color="neutral"
            variant="outline"
            size="sm"
            :active="markHidden"
            active-variant="solid"
            @click="markHidden = !markHidden"
          />
        </UTooltip>
        <!-- How the form opens (CustomDesigner.vue's popover) - its mode as the label. -->
        <slot name="open" />
      </div>
      <!-- Layout tools - desktop only; a phone or a tablet edits content, not layout. -->
      <div
        v-if="!compact"
        class="flex items-center gap-2"
      >
        <UFieldGroup>
          <UTooltip
            v-for="option in COLUMN_LAYOUTS"
            :key="option.columns"
            :text="t('designer.customDesigner.layOutIn', option.columns)"
          >
            <UButton
              :icon="option.icon"
              :aria-label="t('designer.customDesigner.layOutIn', option.columns)"
              color="neutral"
              variant="outline"
              size="sm"
              :active="currentWidth === option.width"
              active-color="primary"
              :disabled="layoutDisabled"
              @click="emit('applyColumns', option.width)"
            />
          </UTooltip>
        </UFieldGroup>
        <UTooltip :text="t('designer.customDesigner.undoColumns')">
          <UButton
            icon="i-lucide-undo-2"
            :aria-label="t('designer.customDesigner.undoColumns')"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="!canUndoColumns"
            @click="emit('undoColumns')"
          />
        </UTooltip>
      </div>
      <div
        v-if="compact || hasRecord"
        class="flex items-center gap-2"
      >
        <!-- A phone or a tablet: the palette, over the page. -->
        <UButton
          v-if="compact"
          :label="t('designer.customDesigner.addWidget')"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="sm"
          @click="emit('addWidget')"
        />
        <!-- The record's columns not on the page yet - what the wizard's Columns step left out. -->
        <UButton
          v-if="hasRecord"
          :label="t('designer.customDesigner.addFieldsEllipsis')"
          icon="i-lucide-list-plus"
          color="neutral"
          variant="outline"
          size="sm"
          @click="emit('addFields')"
        />
      </div>
      <UTooltip
        v-if="!compact"
        :text="inspectorCollapsed ? t('designer.customDesigner.showProperties') : t('designer.customDesigner.hideProperties')"
      >
        <UButton
          :icon="inspectorCollapsed ? 'i-lucide-panel-right-open' : 'i-lucide-panel-right-close'"
          :aria-label="inspectorCollapsed ? t('designer.customDesigner.showProperties') : t('designer.customDesigner.hideProperties')"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="emit('toggleInspector')"
        />
      </UTooltip>
    </div>
  </div>
</template>
