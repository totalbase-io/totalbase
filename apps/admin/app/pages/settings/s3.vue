<script setup lang="ts">
// "Test connection" writes, reads back and deletes a probe object in the
// bucket of the saved s3.* settings - usable before S3 storage is turned on,
// to know it works before Files stores in it. Held while edits are pending.
const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const verifying = ref(false)

async function testConnection() {
  verifying.value = true
  try {
    await api.post('/settings/s3/verify')
    toast.add({ title: t('settings.s3.connectionWorks'), description: t('settings.s3.connectionWorksDescription'), color: 'success' })
  } catch (err) {
    notifyError(err, t('settings.s3.connectionFailed'), t('settings.s3.unreachable'))
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <SettingsGroupForm group="s3">
    <template #actions="{ dirty, off }">
      <UButton
        icon="i-lucide-plug-zap"
        :label="t('settings.s3.testConnection')"
        color="neutral"
        variant="outline"
        :loading="verifying"
        :disabled="dirty || off"
        @click="testConnection"
      />
    </template>
  </SettingsGroupForm>
</template>
