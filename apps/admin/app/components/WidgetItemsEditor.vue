<script setup lang="ts">
/**
 * A Tabs', an Accordion's or a Dropdown menu's items (the `items` editor,
 * Specification_DataViews.md §9.2): one card each - its
 * icon, its label (or a formula for it), and what its prop's `itemFields`
 * give it: a color, a Code function, Disabled and Visible formulas over the
 * page. Each item's key is set once, when it's added, and shown - Code
 * switches tabs by it, and its area (`content:<key>`) keeps what it holds
 * however it's renamed or moved. A Splitter's panels add their size, minimum
 * and Collapsible: the sizes sum to 100 - changing one reshares the rest in
 * proportion, never under a minimum - and a sum that still doesn't reach it
 * is marked.
 */
import { WIDGET_COLORS, type WidgetItem, type WidgetItemField } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'

const props = defineProps<{
  label: string
  description?: string
  fields: readonly WidgetItemField[]
  /** A new item's key: `<prefix><n>` - tab3, section2. */
  keyPrefix: string
  /** The Code's function names - a menu item's to run. */
  codeFunctions?: readonly string[]
  columns?: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const model = defineModel<WidgetItem[] | undefined>({ required: true })
const emit = defineEmits<{ createFunction: [item: number] }>()

const items = computed(() => model.value ?? [])
const has = (field: WidgetItemField) => props.fields.includes(field)

/** One item changed - a cleared field is left out, not kept empty. */
function update(index: number, patch: Partial<WidgetItem>) {
  const next = items.value.map((item, i) => {
    if (i !== index) return item
    return Object.fromEntries(Object.entries({ ...item, ...patch }).filter(([, value]) => value !== undefined && value !== '')) as WidgetItem
  })
  model.value = next
}
function setFormula(index: number, name: 'label' | 'disabled' | 'visible', formula: string) {
  const formulas = Object.fromEntries(Object.entries({ ...items.value[index]?.formulas, [name]: formula }).filter(([, f]) => f.trim() !== ''))
  update(index, { formulas: Object.keys(formulas).length ? formulas : undefined })
}
function add() {
  const taken = new Set(items.value.map(i => i.value))
  let n = items.value.length + 1
  while (taken.has(`${props.keyPrefix}${n}`)) n++
  const added: WidgetItem = { value: `${props.keyPrefix}${n}`, label: `${props.label.replace(/s$/, '')} ${n}` }
  model.value = [...items.value, added]
  // A new panel takes an even share; the others reshare the rest.
  if (has('size')) setSize(items.value.length - 1, Math.round(100 / items.value.length))
}
function remove(index: number) {
  const next = items.value.filter((_, i) => i !== index)
  model.value = next.length ? next : undefined
  if (has('size') && next.length) setSize(0, next[0]!.defaultSize ?? 0)
}
/** Sizes always sum to 100: the change goes to the others in proportion to what they had, none under its minimum. */
function setSize(index: number, size: number) {
  const next = items.value.map(item => ({ ...item }))
  const others = next.filter((_, i) => i !== index)
  const target = next[index]!
  const floor = (item: WidgetItem) => Math.max(0, Math.min(100, item.minSize ?? 0))
  const value = Math.max(floor(target), Math.min(100 - others.reduce((sum, o) => sum + floor(o), 0), Math.round(size)))
  target.defaultSize = value
  const remaining = 100 - value
  const weights = others.map(o => Math.max(o.defaultSize ?? 0, 0))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  others.forEach((o, i) => {
    const share = totalWeight > 0 ? Math.round(remaining * (weights[i]! / totalWeight)) : Math.round(remaining / others.length)
    o.defaultSize = Math.max(floor(o), share)
  })
  // Rounding and minimums leave a remainder: the last other panel takes it.
  const sum = next.reduce((a, item) => a + (item.defaultSize ?? 0), 0)
  const last = others[others.length - 1]
  if (last && sum !== 100) last.defaultSize = Math.max(floor(last), (last.defaultSize ?? 0) + (100 - sum))
  model.value = next
}
const sizeSum = computed(() => items.value.reduce((a, item) => a + (item.defaultSize ?? 0), 0))
function move(index: number, by: -1 | 1) {
  const next = [...items.value]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item!)
  model.value = next
}

/** Reka's select can't hold an empty value. */
const NONE = '__none__'
const { t } = useI18n()
const colorItems = computed(() => [{ label: t('designer.widgetItemsEditor.defaultColor'), value: NONE }, ...WIDGET_COLORS.map(c => ({ label: c, value: c }))])
const functionItems = computed(() => [{ label: t('common.none'), value: NONE }, ...(props.codeFunctions ?? []).map(f => ({ label: f, value: f }))])
</script>

<template>
  <UFormField
    :label="props.label"
    :description="props.description"
  >
    <div class="flex flex-col gap-2">
      <div
        v-for="(item, index) in items"
        :key="item.value ?? index"
        class="flex flex-col gap-2 rounded-md border border-default p-2"
      >
        <div class="flex items-center gap-1.5">
          <IconPickerField
            v-if="has('icon')"
            :model-value="item.icon"
            label=""
            options="lucide"
            clearable
            @update:model-value="update(index, { icon: $event })"
          />
          <UInput
            :model-value="item.label ?? ''"
            :aria-label="t('designer.widgetItemsEditor.itemLabel', { n: index + 1 })"
            size="sm"
            class="min-w-0 flex-1"
            @update:model-value="update(index, { label: String($event ?? '') })"
          />
          <BindingButton
            :model-value="item.formulas?.label ?? ''"
            kind="text"
            :label="t('designer.widgetItemsEditor.itemLabel', { n: index + 1 })"
            :columns="columns"
            :relations="relations"
            @update:model-value="setFormula(index, 'label', $event)"
          />
          <UButton
            icon="i-lucide-arrow-up"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="index === 0"
            :aria-label="t('designer.widgetItemsEditor.moveUp')"
            @click="move(index, -1)"
          />
          <UButton
            icon="i-lucide-arrow-down"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="index === items.length - 1"
            :aria-label="t('designer.widgetItemsEditor.moveDown')"
            @click="move(index, 1)"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('designer.widgetItemsEditor.removeItem')"
            @click="remove(index)"
          />
        </div>
        <!-- A panel's share: its size and minimum in %, and Collapsible. -->
        <div
          v-if="has('size') || has('minSize') || has('collapsible')"
          class="flex flex-wrap items-center gap-3"
        >
          <div
            v-if="has('size')"
            class="flex items-center gap-1.5"
          >
            <span class="text-xs text-muted">{{ t('designer.widgetItemsEditor.size') }}</span>
            <UInputNumber
              :model-value="item.defaultSize ?? 0"
              :min="item.minSize ?? 0"
              :max="100"
              size="sm"
              class="w-24"
              :aria-label="t('designer.widgetItemsEditor.itemSize', { n: index + 1 })"
              @update:model-value="setSize(index, Number($event ?? 0))"
            />
          </div>
          <div
            v-if="has('minSize')"
            class="flex items-center gap-1.5"
          >
            <span class="text-xs text-muted">{{ t('designer.widgetItemsEditor.minSize') }}</span>
            <UInputNumber
              :model-value="item.minSize ?? 0"
              :min="0"
              :max="100"
              size="sm"
              class="w-24"
              :aria-label="t('designer.widgetItemsEditor.itemMinSize', { n: index + 1 })"
              @update:model-value="update(index, { minSize: Number($event ?? 0) || undefined })"
            />
          </div>
          <UCheckbox
            v-if="has('collapsible')"
            :model-value="item.collapsible === true"
            :label="t('designer.widgetItemsEditor.collapsible')"
            size="sm"
            @update:model-value="(v: boolean | 'indeterminate') => update(index, { collapsible: v === true ? true : undefined })"
          />
        </div>
        <div
          v-if="has('color') || has('function')"
          class="flex items-center gap-1.5"
        >
          <USelect
            v-if="has('color')"
            :model-value="item.color ?? NONE"
            :items="colorItems"
            size="sm"
            class="w-28"
            :aria-label="t('common.color')"
            @update:model-value="update(index, { color: $event === NONE ? undefined : $event })"
          />
          <USelect
            v-if="has('function')"
            :model-value="item.onSelect ?? NONE"
            :items="functionItems"
            size="sm"
            class="min-w-0 flex-1"
            :aria-label="t('designer.widgetItemsEditor.function')"
            @update:model-value="update(index, { onSelect: $event === NONE ? undefined : $event })"
          />
          <UTooltip
            v-if="has('function') && !item.onSelect"
            :text="t('designer.widgetItemsEditor.createFunction')"
          >
            <UButton
              icon="i-lucide-square-plus"
              color="neutral"
              variant="outline"
              size="sm"
              :aria-label="t('designer.widgetItemsEditor.createFunction')"
              @click="emit('createFunction', index)"
            />
          </UTooltip>
        </div>
        <div class="flex items-center gap-3 text-xs text-muted">
          <span class="font-mono">{{ item.value }}</span>
          <span
            v-if="has('disabled')"
            class="flex items-center gap-0.5"
          >
            {{ t('designer.widgetItemsEditor.disabled') }}
            <BindingButton
              :model-value="item.formulas?.disabled ?? ''"
              kind="boolean"
              :label="t('designer.widgetItemsEditor.itemDisabled', { n: index + 1 })"
              :columns="columns"
              :relations="relations"
              @update:model-value="setFormula(index, 'disabled', $event)"
            />
          </span>
          <span
            v-if="has('visible')"
            class="flex items-center gap-0.5"
          >
            {{ t('designer.widgetItemsEditor.visible') }}
            <BindingButton
              :model-value="item.formulas?.visible ?? ''"
              kind="boolean"
              :label="t('designer.widgetItemsEditor.itemVisible', { n: index + 1 })"
              :columns="columns"
              :relations="relations"
              @update:model-value="setFormula(index, 'visible', $event)"
            />
          </span>
        </div>
        <p
          v-for="(formula, name) in item.formulas"
          :key="name"
          class="truncate font-mono text-xs text-muted"
        >
          {{ name }} = {{ formula }}
        </p>
      </div>
      <!-- The sizes' sum, marked while it isn't 100 - the panels share what's missing or trim what's over. -->
      <p
        v-if="has('size') && items.length"
        class="flex items-center gap-1 text-xs"
        :class="sizeSum === 100 ? 'text-muted' : 'text-warning'"
      >
        <UIcon
          v-if="sizeSum !== 100"
          name="i-lucide-triangle-alert"
          class="size-3.5"
        />
        {{ t('designer.widgetItemsEditor.sizeSum', { sum: sizeSum }) }}
      </p>
      <UButton
        icon="i-lucide-plus"
        :label="t('designer.widgetItemsEditor.addItem')"
        size="sm"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="add"
      />
    </div>
  </UFormField>
</template>
