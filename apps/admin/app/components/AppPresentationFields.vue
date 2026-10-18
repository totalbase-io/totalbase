<script setup lang="ts">
import type { RoleColor } from '~/types/permission'
/**
 * How a DataView or a dashboard presents itself in the App - whether the menu lists it, its label there,
 * its description (the page's subtitle and the menu's tooltip), its icon and color. One block for the
 * DataView settings and the dashboard details alike; its identity (name, slug) is NameSlugFields'.
 */
const scope = defineModel<'LISTED' | 'EMBEDDED_ONLY'>('scope', { required: true })
const menuLabel = defineModel<string | null>('menuLabel', { required: true })
const description = defineModel<string | null>('description', { required: true })
const icon = defineModel<string | undefined>('icon', { required: true })
const color = defineModel<RoleColor | undefined>('color', { required: true })
defineProps<{
  kind: 'DataView' | 'Dashboard'
  /** Without the menu switch - Organize menu's Edit, whose Remove from the menu stands for it. */
  hideScope?: boolean
  /** Each field's help in a popover at the end of its label's line (FieldHelp in the hint) - Organize menu's Edit - instead of under it. */
  helpPopover?: boolean
}>()
const { t } = useI18n()

const menuLabelText = computed({
  get: () => menuLabel.value ?? '',
  set: (value: string) => { menuLabel.value = value.trim() ? value : null }
})
const descriptionText = computed({
  get: () => description.value ?? '',
  set: (value: string) => { description.value = value.trim() ? value : null }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <ShowInAppMenuField
      v-if="!hideScope"
      v-model="scope"
      :kind="kind"
    />
    <UFormField
      :label="t('shell.nameSlug.menuLabel')"
      :description="helpPopover ? undefined : t('shell.appPresentation.menuLabelHelp')"
    >
      <template
        v-if="helpPopover"
        #hint
      >
        <FieldHelp
          :text="t('shell.appPresentation.menuLabelHelp')"
          :label="t('shell.nameSlug.menuLabel')"
        />
      </template>
      <UInput
        v-model="menuLabelText"
        maxlength="32"
        autocomplete="off"
        :disabled="scope !== 'LISTED'"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('common.description')"
      :description="helpPopover ? undefined : t('shell.appPresentation.descriptionHelp')"
    >
      <template
        v-if="helpPopover"
        #hint
      >
        <FieldHelp
          :text="t('shell.appPresentation.descriptionHelp')"
          :label="t('common.description')"
        />
      </template>
      <UTextarea
        v-model="descriptionText"
        :rows="2"
        maxlength="128"
        class="w-full"
      />
    </UFormField>
    <div class="flex gap-3">
      <IconPickerField
        v-model="icon"
        :label="t('common.icon')"
        options="lucide"
      />
      <ColorPickerField
        v-model="color"
        :label="t('common.color')"
        allow-none
      />
    </div>
  </div>
</template>
