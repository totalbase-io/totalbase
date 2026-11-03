<script setup lang="ts">
/**
 * Arrange menu's settings on a compact screen (Admin_UI.md §8), behind the
 * header's ⚙: the same fields a desktop shows beside the tree
 * (AppMenuSettingsFields.vue), in a slideover (§6.1) - every change applied
 * at once, so no footer.
 */
import type { AppMenuSettings, MenuModuleName } from '~/types/app-menu'

defineProps<{ settings: AppMenuSettings, placedModules: readonly MenuModuleName[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  change: [key: keyof AppMenuSettings, value: string]
  toggleModule: [module: MenuModuleName, on: boolean]
}>()
const { t } = useI18n()
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('settings.appMenuEditor.settings')"
    :description="t('settings.appMenuEditor.settingsDescription')"
  >
    <template #body>
      <AppMenuSettingsFields
        :settings="settings"
        :placed-modules="placedModules"
        @change="(key, value) => emit('change', key, value)"
        @toggle-module="(module, on) => emit('toggleModule', module, on)"
      />
    </template>
  </USlideover>
</template>
