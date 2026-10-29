<script setup lang="ts">
// A role's icon on its own tinted chip - the visual identity used both
// in the roles list (small) and the role detail page's header (large).
// Extracted once a second usage needed the exact same painting logic
// (roleColorShade() + color-mix, see types/permission.ts's doc comment
// for why this isn't a plain --color-<name> CSS variable or a UBadge
// :color prop).
import { roleColor, roleColorShade, roleIcon, type Role } from '~/types/permission'

const props = withDefaults(defineProps<{
  role: Pick<Role, 'icon' | 'color'>
  size?: 'sm' | 'lg'
}>(), {
  size: 'sm'
})

const surfaceTone = useSurfaceTone()
const shade = computed(() => roleColorShade(roleColor(props.role), surfaceTone.value))
const chipStyle = computed(() => ({ backgroundColor: `color-mix(in oklab, ${shade.value} 12%, transparent)` }))
const iconStyle = computed(() => ({ color: shade.value }))

const CHIP_CLASS = { sm: 'size-7 rounded-md', lg: 'size-14 rounded-lg' } as const
const ICON_CLASS = { sm: 'size-4', lg: 'size-7' } as const
</script>

<template>
  <div
    class="flex items-center justify-center shrink-0"
    :class="CHIP_CLASS[size]"
    :style="chipStyle"
  >
    <UIcon
      :name="roleIcon(role)"
      :class="ICON_CLASS[size]"
      :style="iconStyle"
    />
  </div>
</template>
