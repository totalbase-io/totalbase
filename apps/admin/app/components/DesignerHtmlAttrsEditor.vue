<script setup lang="ts">
/**
 * The designer inspectors' Advanced tab: free-form HTML attribute / Nuxt
 * UI prop pairs (field-config.ts's `htmlAttrs`). Edits the rows in place;
 * reserved names are only stripped on save (`sanitizeHtmlAttrs`), so a
 * mistyped entry stays visible instead of vanishing mid-edit.
 */
import type { HtmlAttrRow } from '~/utils/field-config'

const rows = defineModel<HtmlAttrRow[]>({ required: true })

const { t } = useI18n()
function addRow() {
  rows.value.push({ key: '', value: '' })
}
function removeRow(index: number) {
  rows.value.splice(index, 1)
}
</script>

<template>
  <UFormField
    :label="t('designer.designerHtmlAttrsEditor.label')"
    :description="t('designer.designerHtmlAttrsEditor.description')"
  >
    <div class="flex flex-col gap-2">
      <div
        v-if="rows.length > 0"
        class="grid grid-cols-[1fr_1fr_2rem] gap-1.5 text-xs text-muted"
      >
        <span>{{ t('designer.designerHtmlAttrsEditor.attribute') }}</span>
        <span>{{ t('common.value') }}</span>
      </div>
      <div
        v-for="(attr, index) in rows"
        :key="index"
        class="grid grid-cols-[1fr_1fr_2rem] items-center gap-1.5"
      >
        <UInput
          v-model="attr.key"
          :aria-label="t('designer.designerHtmlAttrsEditor.attributeName', { n: index + 1 })"
          size="sm"
          class="w-full font-mono"
        />
        <UInput
          v-model="attr.value"
          :aria-label="t('designer.designerHtmlAttrsEditor.attributeValue', { n: index + 1 })"
          size="sm"
          class="w-full"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('designer.designerHtmlAttrsEditor.removeAttribute')"
          @click="removeRow(index)"
        />
      </div>
      <UButton
        icon="i-lucide-plus"
        :label="t('designer.designerHtmlAttrsEditor.addAttribute')"
        size="sm"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="addRow"
      />
    </div>
  </UFormField>
</template>
