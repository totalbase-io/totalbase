<script setup lang="ts">
/**
 * Style's spacing as the box model design tools and browser devtools draw:
 * the margin ring outside, the padding ring inside, the content in the
 * middle - each side's size at its own edge. A ring's name (MARGIN, PADDING)
 * sets all its sides at once; a side's own size wins over it, and a side
 * without one shows All's, muted - what it really has. A click opens the
 * sizes; None clears.
 */
const props = defineProps<{
  /** The widget's props - `margin`, `marginTop`..., `padding`, `paddingTop`... */
  values: Record<string, unknown>
}>()
const emit = defineEmits<{ set: [prop: string, value: string | undefined] }>()

const SIZES = ['xs', 's', 'm', 'l', 'xl'] as const
type Ring = 'margin' | 'padding'
type Side = 'Top' | 'Bottom' | 'Left' | 'Right'
/** Where each side's button sits on its ring. */
const PLACE: Record<Side, string> = {
  Top: 'top-1 left-1/2 -translate-x-1/2',
  Bottom: 'bottom-1 left-1/2 -translate-x-1/2',
  Left: 'left-1 top-1/2 -translate-y-1/2',
  Right: 'right-1 top-1/2 -translate-y-1/2'
}
const SIDES = Object.keys(PLACE) as Side[]

function own(ring: Ring, side: Side | ''): string | undefined {
  const value = props.values[`${ring}${side}`]
  return typeof value === 'string' ? value : undefined
}
/** What a side shows: its own size, else All's (inherited), else nothing. */
function shown(ring: Ring, side: Side) {
  const value = own(ring, side)
  if (value) return { text: value.toUpperCase(), own: true }
  const all = own(ring, '')
  return { text: all ? all.toUpperCase() : '–', own: false }
}

const { t } = useI18n()
const ringName = (ring: Ring) => t(`designer.styleBoxModel.rings.${ring}`)
const sideName = (side: Side) => t(`designer.styleBoxModel.sides.${side.toLowerCase()}`)

const open = ref<string | null>(null)
function pick(ring: Ring, side: Side | '', size: string | undefined) {
  emit('set', `${ring}${side}`, size)
  open.value = null
}
</script>

<template>
  <!-- The margin ring. -->
  <div class="relative h-44 w-full max-w-80 rounded-md border border-dashed border-accented text-xs">
    <template
      v-for="ring in (['margin', 'padding'] as const)"
      :key="ring"
    >
      <div
        :class="ring === 'padding' ? 'absolute inset-x-12 inset-y-9 rounded-md border border-default bg-elevated' : 'contents'"
      >
        <!-- The ring's name: all its sides at once. -->
        <UPopover
          :open="open === `${ring}-all`"
          @update:open="(isOpen: boolean) => (open = isOpen ? `${ring}-all` : null)"
        >
          <button
            type="button"
            class="absolute left-1.5 top-1 rounded px-1 text-[10px] font-semibold uppercase tracking-wide hover:bg-accented/50"
            :class="own(ring, '') ? 'text-primary' : 'text-muted'"
            :aria-label="t('designer.styleBoxModel.allSidesAria', { ring: ringName(ring) })"
          >
            {{ ringName(ring) }}{{ own(ring, '') ? ` · ${own(ring, '')!.toUpperCase()}` : '' }}
          </button>
          <template #content>
            <div class="flex w-60 flex-col gap-2 p-3">
              <span class="text-xs text-muted capitalize">{{ t('designer.styleBoxModel.allSidesTitle', { ring: ringName(ring) }) }}</span>
              <UFieldGroup class="w-full">
                <UButton
                  v-for="size in [undefined, ...SIZES]"
                  :key="size ?? 'none'"
                  :label="size ? size.toUpperCase() : t('common.none')"
                  size="xs"
                  :color="own(ring, '') === size ? 'primary' : 'neutral'"
                  :variant="own(ring, '') === size ? 'solid' : 'outline'"
                  class="flex-1 justify-center"
                  @click="pick(ring, '', size)"
                />
              </UFieldGroup>
            </div>
          </template>
        </UPopover>

        <!-- Each side at its edge: its own size in primary, else All's muted. -->
        <UPopover
          v-for="side in SIDES"
          :key="side"
          :open="open === `${ring}-${side}`"
          @update:open="(isOpen: boolean) => (open = isOpen ? `${ring}-${side}` : null)"
        >
          <UButton
            :label="shown(ring, side).text"
            size="xs"
            :color="shown(ring, side).own ? 'primary' : 'neutral'"
            :variant="shown(ring, side).own ? 'soft' : 'ghost'"
            class="absolute min-w-7 justify-center"
            :class="[PLACE[side], shown(ring, side).own ? '' : 'text-dimmed']"
            :aria-label="t('designer.styleBoxModel.sideAria', { ring: ringName(ring), side: sideName(side) })"
          />
          <template #content>
            <div class="flex w-60 flex-col gap-2 p-3">
              <span class="text-xs text-muted capitalize">{{ t('designer.styleBoxModel.sideTitle', { ring: ringName(ring), side: sideName(side) }) }}</span>
              <UFieldGroup class="w-full">
                <UButton
                  v-for="size in [undefined, ...SIZES]"
                  :key="size ?? 'none'"
                  :label="size ? size.toUpperCase() : t('common.none')"
                  size="xs"
                  :color="own(ring, side) === size ? 'primary' : 'neutral'"
                  :variant="own(ring, side) === size ? 'solid' : 'outline'"
                  class="flex-1 justify-center"
                  @click="pick(ring, side, size)"
                />
              </UFieldGroup>
            </div>
          </template>
        </UPopover>

        <!-- The content, in the middle of the padding ring. -->
        <div
          v-if="ring === 'padding'"
          class="absolute inset-x-10 inset-y-7 rounded border border-dashed border-accented"
        />
      </div>
    </template>
  </div>
</template>
