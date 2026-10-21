<script setup lang="ts">
import { cardMarkAttrs, type CardMark } from '~/utils/column-conditions'
/**
 * The `KANBAN` layout's own render (DataViewGrid.vue's own `isKanban`
 * branch) - same "dumb, receives lanes/cards already resolved" split
 * DataViewCard.vue/DataViewMap.vue already follow: every value shown
 * here (lane title, card title/description/image) is resolved by the
 * parent via the exact same `useLayoutFormula`
 * CARDS already uses (a Kanban card IS a Card, just grouped into lanes -
 * see types/dataview.ts's own doc comment on `resolveKanbanLayout`) -
 * this component only lays the board out and reports drag gestures back.
 *
 * Card movement uses the browser's own native Drag and Drop API
 * (`draggable`/`dragstart`/`dragover`/`drop`) - no drag&drop library in
 * this app's dependencies, and none is added just for this. The actual PATCH of the moved record's FK column is the
 * PARENT's job (`DataViewGrid.vue`, reusing the exact same `dataApi.patch`
 * the record Edit form already uses) - this component only ever reports
 * "card X was dropped on lane Y", it never touches the network itself.
 */
import type { FormulaRichSegment } from '~/utils/formula-engine'
import { isValidColorValue, roleColorShade } from '~/types/permission'

/**
 * `title`/`description` are always the plain, flattened text (formatting
 * stripped) - the same fallback every other Card/Map/Kanban layout slot
 * already gets (DataViewMap.vue's own `MapPin` doc comment, word for
 * word); `titleRich`/`descriptionRich` are only set when that formula
 * actually used a FORMAT function (BOLD/ITALIC/.../BADGE/ICON/NEW_LINE) -
 * `richHtml` below renders THOSE through `renderRichTextHtml` instead of
 * the plain escaped text when present. Always a SAFE `v-html`, never raw/
 * unsanitized HTML - that function's own doc comment: every segment's own
 * text still goes through its own `escapeHtml` regardless of which
 * segment it landed in.
 */
export interface KanbanCard {
  key: string
  title: string
  titleRich?: FormulaRichSegment[]
  description: string | null
  descriptionRich?: FormulaRichSegment[]
  /** Same `null` (no Image formula mapped at all) vs. falsy (mapped but empty for this row) distinction DataViewCard.vue's own `imageSrc` doc comment already uses. */
  imageSrc?: string | null
  row: Record<string, unknown>
}
export interface KanbanLane {
  /** The related table's own PK (as a string - `KanbanLayoutConfig.laneOrder`'s own doc comment) - or `KANBAN_UNASSIGNED_KEY` for the fixed trailing lane. */
  key: string
  title: string
  /** The lane's color (KanbanLayoutConfig.laneColorColumn) - a palette name or hex; null for a plain lane. */
  color: string | null
  /** An icon before its title - a CHECK value's, from its column's presentation. */
  icon?: string | null
  /** Whether a card can be DROPPED here - always true for a real lane; the fixed Unassigned lane only accepts drops when the FK column is nullable (a NOT NULL column can still have pre-existing null rows to SHOW, just nothing new can be dropped there - types/dataview.ts's own doc comment). */
  droppable: boolean
  cards: KanbanCard[]
}

const props = defineProps<{
  lanes: KanbanLane[]
  canWrite: boolean
  /** A row condition's mark on its card (DataViews.md §15.7). */
  markOf?: (row: Record<string, unknown>) => CardMark | null
}>()
/** Keys of the folded lanes: a narrow strip with the title and count, still a drop target. */
const collapsed = defineModel<string[]>('collapsed', { default: () => [] })
function toggleLane(key: string) {
  collapsed.value = collapsed.value.includes(key) ? collapsed.value.filter(k => k !== key) : [...collapsed.value, key]
}
const emit = defineEmits<{
  edit: [Record<string, unknown>]
  /** A card was dropped on a DIFFERENT lane than the one it started in - `targetLaneKey` is that lane's own `key` (a related-table PK, or KANBAN_UNASSIGNED_KEY). */
  move: [{ row: Record<string, unknown>, targetLaneKey: string }]
}>()
const { t } = useI18n()

// Native DnD only ever tracks ONE card being dragged at a time - a plain
// module-local-ish ref (not per-lane state) is all this needs, cleared on
// `dragend` regardless of whether the drop itself landed on a valid
// target (same "always clean up" discipline a `finally` block would use).
const draggingCard = ref<{ card: KanbanCard, fromLaneKey: string } | null>(null)
const dragOverLaneKey = ref<string | null>(null)

function onDragStart(card: KanbanCard, fromLaneKey: string) {
  if (!props.canWrite) return
  draggingCard.value = { card, fromLaneKey }
}
function onDragEnd() {
  draggingCard.value = null
  dragOverLaneKey.value = null
}
function onDrop(lane: KanbanLane) {
  dragOverLaneKey.value = null
  const dragging = draggingCard.value
  draggingCard.value = null
  if (!dragging || !lane.droppable || dragging.fromLaneKey === lane.key) return
  emit('move', { row: dragging.card.row, targetLaneKey: lane.key })
}

const colorMode = useColorMode()
function laneStyle(lane: KanbanLane) {
  return lane.color && isValidColorValue(lane.color) ? { borderTopColor: roleColorShade(lane.color, colorMode.value === 'dark' ? 'dark' : 'light') } : undefined
}
// Each card's rich title/description (KanbanCard's doc comment) as safe HTML, keyed by `card.key`.
const richHtml = useRichHtml(() => props.lanes.flatMap(lane => lane.cards))
</script>

<template>
  <div class="flex size-full min-h-96 gap-4 overflow-x-auto pb-2">
    <div
      v-for="lane in lanes"
      :key="lane.key"
      class="flex shrink-0 flex-col rounded-lg bg-elevated/50"
      :class="[collapsed.includes(lane.key) ? 'w-11' : 'w-72', { 'ring-2 ring-primary/50': dragOverLaneKey === lane.key && lane.droppable }]"
      @dragover.prevent="dragOverLaneKey = lane.key"
      @dragleave="dragOverLaneKey === lane.key && (dragOverLaneKey = null)"
      @drop.prevent="onDrop(lane)"
    >
      <!-- Folded: the whole strip unfolds it - its title runs down the side, its count on top. -->
      <button
        v-if="collapsed.includes(lane.key)"
        type="button"
        class="flex flex-1 flex-col items-center gap-2 rounded-lg border-t-3 px-1 py-2.5"
        :class="laneStyle(lane) ? '' : 'border-transparent'"
        :style="laneStyle(lane)"
        :aria-label="t('dataviews.layouts.expandLane', { name: lane.title })"
        @click="toggleLane(lane.key)"
      >
        <span class="shrink-0 rounded-full bg-default px-1.5 py-0.5 text-xs text-muted">
          {{ lane.cards.length }}
        </span>
        <span class="truncate text-sm font-semibold text-highlighted [writing-mode:vertical-rl]">
          {{ lane.title }}
        </span>
      </button>

      <div
        v-else
        class="flex shrink-0 items-center justify-between gap-2 border-t-3 py-2 pr-1.5 pl-3"
        :class="laneStyle(lane) ? '' : 'border-transparent'"
        :style="laneStyle(lane)"
      >
        <p class="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-highlighted">
          <UIcon
            v-if="lane.icon"
            :name="lane.icon"
            class="size-4 shrink-0"
          />
          <span class="truncate">{{ lane.title }}</span>
        </p>
        <div class="flex shrink-0 items-center gap-1">
          <span class="rounded-full bg-default px-1.5 py-0.5 text-xs text-muted">
            {{ lane.cards.length }}
          </span>
          <UTooltip :text="t('dataviews.layouts.collapse')">
            <UButton
              icon="i-lucide-chevrons-right-left"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('dataviews.layouts.collapse')"
              @click="toggleLane(lane.key)"
            />
          </UTooltip>
        </div>
      </div>

      <div
        v-if="!collapsed.includes(lane.key)"
        class="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
      >
        <p
          v-if="lane.cards.length === 0"
          class="px-1 py-4 text-center text-xs text-muted"
        >
          {{ t('dataviews.layouts.noCards') }}
        </p>

        <div
          v-for="card in lane.cards"
          :key="card.key"
          :draggable="canWrite"
          class="group flex shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-default bg-default transition-colors hover:border-primary/50 hover:shadow-sm"
          :class="[{ 'cursor-grab': canWrite, 'opacity-40': draggingCard?.card.key === card.key }, cardMarkAttrs(markOf?.(card.row)).class]"
          :style="cardMarkAttrs(markOf?.(card.row)).style"
          role="button"
          tabindex="0"
          @click="emit('edit', card.row)"
          @keydown.enter.space.self.prevent="emit('edit', card.row)"
          @dragstart="onDragStart(card, lane.key)"
          @dragend="onDragEnd"
        >
          <div
            v-if="card.imageSrc !== null"
            class="flex aspect-video w-full items-center justify-center overflow-hidden bg-elevated"
          >
            <img
              v-if="card.imageSrc"
              :src="card.imageSrc"
              alt=""
              class="size-full object-cover"
            >
            <UIcon
              v-else
              name="i-lucide-image"
              class="size-6 text-muted"
            />
          </div>

          <div class="flex flex-col gap-1 p-2.5">
            <UTooltip
              :text="card.title"
              class="block w-full"
            >
              <!-- `richHtml[card.key]?.title` (KanbanCard's own doc
              comment) - a safe, pre-sanitized `v-html` from
              renderRichTextHtml, only ever set when the title formula
              actually used a FORMAT function; every other card falls
              back to the plain escaped text below, unchanged. -->
              <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
              <p
                v-if="richHtml[card.key]?.title"
                class="truncate text-sm font-medium text-highlighted"
                v-html="richHtml[card.key]!.title"
              />
              <!-- eslint-enable vue/no-v-html -->
              <p
                v-else
                class="truncate text-sm font-medium text-highlighted"
              >
                {{ card.title }}
              </p>
            </UTooltip>
            <UTooltip
              v-if="card.description"
              :text="card.description"
              class="block w-full"
            >
              <!-- `whitespace-pre-line` - same fix DataViewCard.vue's own description just got: a formula's literal `\n` (typed, or NEW_LINE() flattened down by formula-engine.ts's own `flattenRichText`) would otherwise collapse to a plain space; NEW_LINE() itself renders as a real `<br>` in the rich path below instead, so it doesn't need this either way. -->
              <!-- eslint-disable vue/no-v-html -- built by renderRichTextHtml: text escaped, fixed tags, http(s)/mailto/tel links only -->
              <p
                v-if="richHtml[card.key]?.description"
                class="line-clamp-2 whitespace-pre-line text-xs text-muted"
                v-html="richHtml[card.key]!.description"
              />
              <!-- eslint-enable vue/no-v-html -->
              <p
                v-else
                class="line-clamp-2 whitespace-pre-line text-xs text-muted"
              >
                {{ card.description }}
              </p>
            </UTooltip>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
