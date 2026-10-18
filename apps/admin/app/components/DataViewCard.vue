<script setup lang="ts">
import { cardMarkAttrs, type CardMark } from '~/utils/column-conditions'
/**
 * One card in the `CARDS` layout's grid (DataViewGrid.vue's own `isCards`
 * branch, which replaces its `<UTable>` with a `<DataViewCard>` per row
 * instead of duplicating the toolbar/fetch/pagination/delete plumbing in
 * a parallel component). Deliberately
 * "dumb": every value shown here (title/description text, image URL) is
 * already resolved by the parent (bindings v2 + `config.displayFormat`,
 * the SAME `computedValueResolver`/`formatCellPlainText` TABLE's own
 * cells use - build-dataview-columns.ts) - this component only lays the
 * result out, same "resolve once in the parent, render dumb in the
 * child" split TABLE's own `buildDataViewColumns` already follows.
 *
 * The whole card is click-to-edit, always - unlike TABLE's switchable
 * `features.rowEdit`, a non-clickable card makes no sense (there's no
 * separate "open" affordance otherwise). The footer's Edit/Delete
 * buttons and the selection checkbox each stop their own click from
 * bubbling to the card, so they don't ALSO fire the card's edit.
 *
 * `title`/`description` are always the plain, flattened text (formatting
 * stripped); `titleRich`/`descriptionRich` are only set when that
 * formula actually used a FORMAT function (BOLD/.../BADGE/ICON/NEW_LINE)
 * - same convention DataViewMap.vue's own `MapPin`/DataViewKanban.vue's
 * own `KanbanCard` already use, rendered here through the exact same
 * `renderRichTextHtml` (a safe, pre-sanitized `v-html` - that function's
 * own doc comment: every segment's own text is still escaped regardless
 * of which segment it landed in).
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { FormulaRichSegment } from '~/utils/formula-engine'
import type { CardImageAspect } from '~/types/dataview'

const props = defineProps<{
  title: string
  titleRich?: FormulaRichSegment[]
  description?: string | null
  descriptionRich?: FormulaRichSegment[]
  /** `null` = no Image column mapped at all (the card never shows an image block); `undefined`/empty = mapped but empty for this row (shows the placeholder icon). */
  imageSrc?: string | null
  /** card_layout's image shape, fit and crop (types/dataview.ts CardLayoutConfig) - unset, a 16:9 band covered from its center. */
  imageAspect?: CardImageAspect | null
  imageFit?: 'cover' | 'contain' | null
  imagePosition?: 'top' | 'center' | null
  /** Its size: normal; compact (a one-line description); tiny - the image alone, its title and description in a tooltip. */
  density?: 'normal' | 'compact' | 'tiny'
  /** A row condition that holds for it (Specification_DataViews.md §15.7): a colored edge, dimmed. */
  mark?: CardMark | null
  /** The record's "⋮" (utils/record-menu.ts) - none when empty. */
  menu: DropdownMenuItem[][]
  selectable: boolean
  selected: boolean
}>()
const emit = defineEmits<{ 'edit': [], 'toggle-select': [] }>()
const { t } = useI18n()
const tiny = computed(() => props.density === 'tiny')
/** Very compact: the title and description it doesn't show, for a tooltip and a screen reader. */
const summary = computed(() => [props.title, props.description].filter(Boolean).join(' - '))

/** The image block's shape and how the image sits in it - written out in full, for Tailwind. */
const ASPECT_CLASSES: Record<string, string> = { '1:1': 'aspect-square', '3:4': 'aspect-[3/4]', '4:3': 'aspect-[4/3]', '16:9': 'aspect-video' }
const imageBox = computed(() => {
  const original = props.imageAspect === 'original'
  const fit = props.imageFit === 'contain' ? 'object-contain' : 'object-cover'
  const position = props.imagePosition === 'top' ? 'object-top' : 'object-center'
  return {
    // Original: the image's own shape - a placeholder (no image on this row) still keeps some height.
    box: original ? (props.imageSrc ? undefined : 'min-h-24') : ASPECT_CLASSES[props.imageAspect ?? '16:9'],
    image: original ? 'h-auto w-full' : `size-full ${fit} ${position}`
  }
})

// This card's rich title/description as safe HTML - one card per instance.
const richHtml = useRichHtml(() => [{ key: 'card', titleRich: props.titleRich, descriptionRich: props.descriptionRich }])
const titleHtml = computed(() => richHtml.value.card?.title)
const descriptionHtml = computed(() => richHtml.value.card?.description)
</script>

<template>
  <div
    class="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-default bg-default transition-colors hover:border-primary/50 hover:shadow-sm"
    :class="cardMarkAttrs(mark).class"
    :style="cardMarkAttrs(mark).style"
    :title="tiny ? summary : undefined"
    :aria-label="summary"
    role="button"
    tabindex="0"
    @click="emit('edit')"
    @keydown.enter.space.self.prevent="emit('edit')"
  >
    <UCheckbox
      v-if="selectable"
      :model-value="selected"
      class="absolute left-2 top-2 z-10 rounded-md bg-default p-1 shadow-md ring-1 ring-default"
      :class="tiny && !selected ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100' : undefined"
      :aria-label="t('dataviews.layouts.selectCard')"
      @click.stop
      @update:model-value="emit('toggle-select')"
    />
    <!-- The record's "⋮" - over the corner, never opening the card. -->
    <div
      v-if="menu.length"
      class="absolute right-2 top-2 z-10"
      :class="tiny ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : undefined"
      @click.stop
    >
      <UDropdownMenu
        :items="menu"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="subtle"
          size="xs"
          :aria-label="t('dataviews.record.actions')"
        />
      </UDropdownMenu>
    </div>

    <!-- Image block - omitted entirely when no Image column is mapped
    (imageSrc === null); a placeholder icon when mapped but empty on
    THIS row (imageSrc falsy but not null). -->
    <div
      v-if="imageSrc !== null"
      class="flex w-full items-center justify-center overflow-hidden bg-elevated"
      :class="imageBox.box"
    >
      <img
        v-if="imageSrc"
        :src="imageSrc"
        alt=""
        :class="imageBox.image"
      >
      <UIcon
        v-else
        name="i-lucide-image"
        class="size-8 text-muted"
      />
    </div>

    <div
      v-if="!tiny"
      class="flex flex-1 flex-col gap-1"
      :class="density === 'compact' ? 'p-2' : 'p-3'"
    >
      <!-- 1 line, truncated - `UTooltip` (same pattern BindingButton.vue/
      the record form's frame (DataViewRecordPanel.vue) already use) reveals the full value on hover
      regardless of whether it actually overflows, so a long title is
      never silently unreadable. -->
      <UTooltip
        :text="title"
        class="block w-full"
      >
        <!-- `titleHtml` (a safe, pre-sanitized `v-html` from
        renderRichTextHtml - this file's own top doc comment) only when
        the title formula actually used a FORMAT function; every other
        card falls back to the plain escaped text below, unchanged. -->
        <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
        <p
          v-if="titleHtml"
          class="text-sm font-semibold text-highlighted"
          :class="density === 'normal' || !density ? 'line-clamp-2 break-words' : 'truncate'"
          v-html="titleHtml"
        />
        <!-- eslint-enable vue/no-v-html -->
        <p
          v-else
          class="text-sm font-semibold text-highlighted"
          :class="density === 'normal' || !density ? 'line-clamp-2 break-words' : 'truncate'"
        >
          {{ title }}
        </p>
      </UTooltip>
      <UTooltip
        v-if="description"
        :text="description"
        class="block w-full"
      >
        <!-- `whitespace-pre-line` - a formula's own literal `\n` (a plain
        typed newline, OR a FORMAT formula's `NEW_LINE()` flattened down
        to one by `flattenRichText` - formula-engine.ts's own doc comment)
        would otherwise collapse to a plain space, same fix DataViewMap.
        vue's own popup CSS already applies to its description; NEW_LINE()
        itself renders as a real `<br>` in the rich path below instead. -->
        <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
        <p
          v-if="descriptionHtml"
          :class="density === 'compact' ? 'truncate' : 'line-clamp-2 whitespace-pre-line'"
          class="text-xs text-muted"
          v-html="descriptionHtml"
        />
        <!-- eslint-enable vue/no-v-html -->
        <p
          v-else
          :class="density === 'compact' ? 'truncate' : 'line-clamp-2 whitespace-pre-line'"
          class="text-xs text-muted"
        >
          {{ description }}
        </p>
      </UTooltip>
    </div>
  </div>
</template>
