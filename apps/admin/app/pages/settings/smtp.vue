<script setup lang="ts">
import { useApiErrorMessage } from '~/utils/api-error-message'
// "Test connection" connects and authenticates through the saved smtp.*
// settings without sending anything; "Send test email" delivers one
// message - the ways to know the relay works before a real invitation or
// reset email fails. Popover, not a modal: one field.
const api = useAdminApi()
const toast = useToast()
const session = useSession()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const open = ref(false)
const to = ref('')
const sending = ref(false)
const failure = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  to.value ||= session.admin.value?.email ?? ''
  failure.value = null
})

const verifying = ref(false)

async function testConnection() {
  verifying.value = true
  try {
    await api.post('/settings/mail/verify')
    toast.add({ title: t('settings.smtp.connectionWorks'), description: t('settings.smtp.connectionWorksDescription'), color: 'success' })
  } catch (err) {
    notifyError(err, t('settings.smtp.connectionFailed'), t('settings.smtp.unreachable'))
  } finally {
    verifying.value = false
  }
}

async function sendTest() {
  sending.value = true
  failure.value = null
  try {
    await api.post('/settings/mail/test', { data: { to: to.value } })
    toast.add({ title: t('settings.smtp.testSent'), description: t('settings.smtp.checkInbox', { to: to.value }), color: 'success' })
    open.value = false
  } catch (err) {
    failure.value = errorMessage(err, t('settings.smtp.sendFailed'))
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <SettingsGroupForm group="smtp">
    <template #actions="{ dirty }">
      <!-- Both use the saved settings: held while edits are pending. -->
      <UButton
        icon="i-lucide-plug-zap"
        :label="t('settings.smtp.testConnection')"
        color="neutral"
        variant="outline"
        :loading="verifying"
        :disabled="dirty"
        @click="testConnection"
      />
      <UPopover v-model:open="open">
        <UButton
          icon="i-lucide-send"
          :label="t('settings.smtp.sendTestEmail')"
          color="neutral"
          variant="outline"
          :disabled="dirty"
        />
        <template #content>
          <form
            class="flex w-80 flex-col gap-3 p-4"
            @submit.prevent="sendTest"
          >
            <UFormField
              :label="t('settings.smtp.sendTo')"
              :description="t('settings.smtp.sendToDescription')"
            >
              <UInput
                v-model="to"
                type="email"
                autocomplete="email"
                class="w-full"
              />
            </UFormField>
            <p
              v-if="failure"
              class="text-sm text-error"
            >
              {{ failure }}
            </p>
            <div class="flex justify-end">
              <UButton
                type="submit"
                :label="t('settings.smtp.send')"
                :loading="sending"
                :disabled="!to.includes('@')"
              />
            </div>
          </form>
        </template>
      </UPopover>
    </template>
  </SettingsGroupForm>
</template>
