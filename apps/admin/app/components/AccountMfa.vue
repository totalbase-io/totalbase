<script setup lang="ts">
/**
 * My account's two-factor authentication (Security.md §2.17), one row of the Sign-in section: its state and
 * what can be done about it.
 * - Set up: a modal in stages - the current password (an account without one has only its session to show),
 *   then the QR code and the app's first code, then the recovery codes, shown once. Not a WizardModal
 *   (Admin_UI.md §6.7): each stage already did its work on the server and there is no going back to one.
 * - Turn off (the password and a code - refused while the instance requires it) and New recovery codes
 *   (a code), in one modal asking for what each needs.
 */
import type { MfaStatus } from '~/types/security'

const props = defineProps<{
  status: MfaStatus
  hasPassword: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const appApi = useAppApi()
const toast = useToast()
const notifyError = useErrorToast()
const { dateTime } = useDateTimeFormat()

// --- Set up ---
const setupOpen = ref(false)
const stage = ref<'password' | 'scan' | 'codes'>('password')
const password = ref('')
const code = ref('')
const busy = ref(false)
const enrollment = ref<{ secret: string, otpauthUrl: string } | null>(null)
const recoveryCodes = ref<string[]>([])

async function openSetup() {
  password.value = ''
  code.value = ''
  enrollment.value = null
  recoveryCodes.value = []
  setupOpen.value = true
  stage.value = 'password'
  if (!props.hasPassword) await start()
}

async function start() {
  busy.value = true
  try {
    const { data } = await appApi.post<{ secret: string, otpauthUrl: string }>('/me/mfa', { data: { currentPassword: password.value } })
    enrollment.value = data
    stage.value = 'scan'
  } catch (err) {
    notifyError(err, t('account.mfa.startError'))
  } finally {
    busy.value = false
  }
}

async function confirm() {
  busy.value = true
  try {
    const { data } = await appApi.post<{ recoveryCodes: string[] }>('/me/mfa/confirm', { data: { code: code.value.replace(/\s/g, '') } })
    recoveryCodes.value = data.recoveryCodes
    stage.value = 'codes'
    emit('changed')
  } catch (err) {
    code.value = ''
    notifyError(err, t('account.mfa.confirmError'))
  } finally {
    busy.value = false
  }
}

// --- Turn off / new recovery codes ---
const action = ref<'disable' | 'codes' | null>(null)
const actionOpen = computed({
  get: () => action.value !== null,
  set: (open: boolean) => {
    if (!open) action.value = null
  }
})
const actionPassword = ref('')
const actionCode = ref('')
const useRecovery = ref(false)
const newCodes = ref<string[]>([])

function openAction(kind: 'disable' | 'codes') {
  actionPassword.value = ''
  actionCode.value = ''
  useRecovery.value = false
  newCodes.value = []
  action.value = kind
}

const actionReady = computed(() => {
  if (action.value === 'disable' && props.hasPassword && !actionPassword.value) return false
  return useRecovery.value ? actionCode.value.trim().length > 0 : /^\d{6}$/.test(actionCode.value.replace(/\s/g, ''))
})

async function runAction() {
  if (!actionReady.value) return
  busy.value = true
  const proof = useRecovery.value ? { recoveryCode: actionCode.value.trim() } : { code: actionCode.value.replace(/\s/g, '') }
  try {
    if (action.value === 'disable') {
      await appApi.post('/me/mfa/disable', { data: { currentPassword: actionPassword.value, ...proof } })
      action.value = null
      toast.add({ title: t('account.mfa.disabled'), color: 'success' })
    } else {
      const { data } = await appApi.post<{ recoveryCodes: string[] }>('/me/mfa/recovery-codes', { data: proof })
      newCodes.value = data.recoveryCodes
    }
    emit('changed')
  } catch (err) {
    actionCode.value = ''
    notifyError(err, action.value === 'disable' ? t('account.mfa.disableError') : t('account.mfa.codesError'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dt class="text-muted">
    {{ t('account.mfa.label') }}
  </dt>
  <dd class="flex flex-col gap-1">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span v-if="status.enabled">{{ t('account.mfa.onSince', { date: dateTime(status.enabledAt!) }) }}</span>
      <span
        v-else
        :class="status.required ? 'text-warning' : 'text-muted'"
      >{{ status.required ? t('account.mfa.offRequired') : t('account.mfa.off') }}</span>
      <template v-if="status.enabled">
        <UButton
          :label="t('account.mfa.newCodes')"
          icon="i-lucide-list-restart"
          color="neutral"
          variant="outline"
          size="xs"
          @click="openAction('codes')"
        />
        <UButton
          v-if="!status.required"
          :label="t('account.mfa.turnOff')"
          icon="i-lucide-shield-off"
          color="neutral"
          variant="outline"
          size="xs"
          @click="openAction('disable')"
        />
      </template>
      <UButton
        v-else
        :label="t('account.mfa.setUp')"
        icon="i-lucide-shield-check"
        color="neutral"
        variant="outline"
        size="xs"
        @click="openSetup"
      />
    </div>
    <span
      v-if="status.enabled"
      :class="status.recoveryCodesLeft <= 2 ? 'text-warning' : 'text-muted'"
      class="text-xs"
    >{{ t('account.mfa.codesLeft', { n: status.recoveryCodesLeft }) }}</span>
    <span
      v-if="status.enabled && status.required"
      class="text-xs text-muted"
    >{{ t('account.mfa.required') }}</span>
  </dd>

  <UModal
    v-model:open="setupOpen"
    :title="t('account.mfa.setupTitle')"
    :description="t('account.mfa.setupDescription')"
    :dismissible="stage !== 'codes'"
  >
    <template #body>
      <form
        v-if="stage === 'password'"
        id="mfa-password-form"
        @submit.prevent="start"
      >
        <UFormField
          :label="t('account.email.currentPassword')"
          :description="t('account.mfa.passwordDescription')"
          required
        >
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            autofocus
            class="w-full"
          />
        </UFormField>
      </form>
      <form
        v-else-if="stage === 'scan' && enrollment"
        id="mfa-confirm-form"
        class="flex flex-col gap-5"
        @submit.prevent="confirm"
      >
        <MfaQrCode
          :otpauth-url="enrollment.otpauthUrl"
          :secret="enrollment.secret"
        />
        <UFormField
          :label="t('auth.mfa.code')"
          :description="t('account.mfa.codeDescription')"
          required
        >
          <UInput
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
            autofocus
            class="w-full font-mono"
          />
        </UFormField>
      </form>
      <MfaRecoveryCodes
        v-else-if="stage === 'codes'"
        :codes="recoveryCodes"
      />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="stage === 'codes'">
          <UButton
            :label="t('common.done')"
            @click="setupOpen = false"
          />
        </template>
        <template v-else>
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="busy"
            @click="setupOpen = false"
          />
          <UButton
            v-if="stage === 'password'"
            type="submit"
            form="mfa-password-form"
            :label="t('auth.mfa.continue')"
            :loading="busy"
            :disabled="!password"
          />
          <UButton
            v-else
            type="submit"
            form="mfa-confirm-form"
            :label="t('account.mfa.turnOn')"
            :loading="busy"
            :disabled="!/^\d{6}$/.test(code.replace(/\s/g, ''))"
          />
        </template>
      </div>
    </template>
  </UModal>

  <UModal
    v-model:open="actionOpen"
    :title="action === 'disable' ? t('account.mfa.disableTitle') : t('account.mfa.codesTitle')"
    :description="action === 'disable' ? t('account.mfa.disableDescription') : t('account.mfa.codesDescription')"
    :dismissible="newCodes.length === 0"
  >
    <template #body>
      <MfaRecoveryCodes
        v-if="newCodes.length"
        :codes="newCodes"
      />
      <form
        v-else
        id="mfa-action-form"
        class="flex flex-col gap-5"
        @submit.prevent="runAction"
      >
        <UFormField
          v-if="action === 'disable' && hasPassword"
          :label="t('account.email.currentPassword')"
          required
        >
          <UInput
            v-model="actionPassword"
            type="password"
            autocomplete="current-password"
            autofocus
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="useRecovery ? t('auth.mfa.recoveryCode') : t('auth.mfa.code')"
          required
        >
          <template #hint>
            <UButton
              v-if="action === 'disable'"
              :label="useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery')"
              color="neutral"
              variant="link"
              size="xs"
              class="px-0"
              @click="useRecovery = !useRecovery; actionCode = ''"
            />
          </template>
          <UInput
            v-model="actionCode"
            :inputmode="useRecovery ? 'text' : 'numeric'"
            :autocomplete="useRecovery ? 'off' : 'one-time-code'"
            class="w-full font-mono"
          />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          v-if="newCodes.length"
          :label="t('common.done')"
          @click="action = null"
        />
        <template v-else>
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="busy"
            @click="action = null"
          />
          <UButton
            type="submit"
            form="mfa-action-form"
            :label="action === 'disable' ? t('account.mfa.turnOff') : t('account.mfa.generate')"
            :color="action === 'disable' ? 'error' : 'primary'"
            :loading="busy"
            :disabled="!actionReady"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
