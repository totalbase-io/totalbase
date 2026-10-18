<script setup lang="ts">
/**
 * Settings > Appearance (Specification_Admin_UI.md §4.1.1): the generic
 * settings form plus Preview - the draft's primary and neutral colors and custom CSS
 * applied to this window, nothing saved, so the operator sees the result
 * before committing it. The <style> it injects comes after the operator's
 * linked stylesheet, so it wins over the saved values while it is on, and
 * goes with the page.
 */
import { neutralColorCss, primaryColorCss } from '@totalbase/shared'

const { t } = useI18n()
const { refresh } = useInstance()

const PREVIEW_ID = 'totalbase-theme-preview'
const previewing = ref(false)
const currentDraft = ref<Record<string, unknown>>({})

function applyPreview() {
  let style = document.getElementById(PREVIEW_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = PREVIEW_ID
    document.head.appendChild(style)
  }
  const color = String(currentDraft.value['appearance.primary_color'] ?? '')
  const css = String(currentDraft.value['appearance.custom_css'] ?? '')
  const neutral = String(currentDraft.value['appearance.neutral_color'] ?? 'slate')
  style.textContent = `${primaryColorCss(color)}${neutralColorCss(neutral, true)}${css}`
}
function clearPreview() {
  document.getElementById(PREVIEW_ID)?.remove()
}
function togglePreview(draft: Record<string, unknown>) {
  currentDraft.value = draft
  previewing.value = !previewing.value
  if (previewing.value) applyPreview()
  else clearPreview()
}
watch(currentDraft, () => {
  if (previewing.value) applyPreview()
}, { deep: true })
onBeforeUnmount(clearPreview)

// A saved layout or sign-in text shows everywhere through useInstance - read it again.
async function onSaved() {
  previewing.value = false
  clearPreview()
  await refresh().catch(() => undefined)
}
</script>

<template>
  <SettingsGroupForm
    group="appearance"
    @saved="onSaved"
  >
    <template #actions="{ draft }">
      <UButton
        :label="previewing ? t('settings.appearance.stopPreview') : t('settings.appearance.preview')"
        :icon="previewing ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        :color="previewing ? 'primary' : 'neutral'"
        variant="outline"
        @click="togglePreview(draft)"
      />
    </template>
  </SettingsGroupForm>
</template>
