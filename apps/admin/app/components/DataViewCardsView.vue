<script setup lang="ts">
import type { CardMark } from '~/utils/column-conditions'
// CARDS layout of a DataView grid: rows as a responsive grid of
// DataViewCard.vue, each slot a formula (`card_layout`, types/dataview.ts).
// Always click-to-edit - DataViewCard.vue's doc comment on why. The grid
// owns fetching, selection and each card's "⋮" menu; this renders and emits.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { CardLayoutConfig, DataViewField, Density } from '~/types/dataview'

const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: CardLayoutConfig
  /** The viewer's card size (their Density, as a table's): narrower cards, then the image alone. */
  density?: Density
  primaryKey?: string
  /** A row condition's mark on its card (Specification_DataViews.md §15.7). */
  markOf?: (row: Record<string, unknown>) => CardMark | null
  /** Each row's "⋮" (DataViewGrid.vue's rowMenu). */
  rowMenu?: (row: Record<string, unknown>) => DropdownMenuItem[][]
  selectable: boolean
  selection: Record<string, boolean>
  pending: boolean
}>()
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'toggle-select': [index: number]
}>()

const { t } = useI18n()
/** Each density's narrowest card - a phone fits about two, three and four across. */
const CARD_MIN_WIDTH: Record<Density, string> = { normal: '160px', compact: '110px', tiny: '76px' }
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.titleFormula, props.layout?.descriptionFormula, props.layout?.imageFormula])

const cards = computed(() => props.rows.map((row, index) => {
  const title = formula.evaluateRich(props.layout?.titleFormula, row)
  const description = props.layout?.descriptionFormula ? formula.evaluateRich(props.layout.descriptionFormula, row) : null
  return {
    key: props.primaryKey ? String(row[props.primaryKey]) : String(index),
    row,
    title: title.text,
    titleRich: title.rich,
    description: description?.text || null,
    descriptionRich: description?.rich,
    // null = no Image formula (no image block); '' = set but empty for this row (placeholder icon).
    imageSrc: props.layout?.imageFormula ? (formula.imageSrc(props.layout.imageFormula, row) ?? '') : null
  }
}))
</script>

<template>
  <div
    class="grid"
    :class="density === 'tiny' ? 'gap-2' : density === 'compact' ? 'gap-3' : 'gap-4'"
    :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH[density ?? 'normal']}, 1fr))` }"
  >
    <UEmpty
      v-if="!pending && rows.length === 0"
      variant="naked"
      size="sm"
      icon="i-lucide-inbox"
      :title="t('dataviews.layouts.noRows')"
      class="col-span-full"
    />
    <DataViewCard
      v-for="(card, index) in cards"
      :key="card.key"
      :title="card.title"
      :title-rich="card.titleRich"
      :description="card.description"
      :description-rich="card.descriptionRich"
      :image-src="card.imageSrc"
      :density="density"
      :image-aspect="layout?.imageAspect"
      :image-fit="layout?.imageFit"
      :image-position="layout?.imagePosition"
      :menu="rowMenu?.(card.row) ?? []"
      :mark="markOf?.(card.row)"
      :selectable="selectable"
      :selected="!!selection[index]"
      @edit="emit('edit', card.row)"
      @toggle-select="emit('toggle-select', index)"
    />
  </div>
</template>
