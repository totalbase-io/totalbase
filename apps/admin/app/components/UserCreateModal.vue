<script setup lang="ts">
/**
 * New user - a complete, ready-to-log-in account: name, email, password,
 * and roles set right here, distinct from UserInviteModal.vue (the
 * passwordless path). See POST /admin/api/users in admin-users.ts.
 *
 * Shared by the Users panel and a role's Users tab - with `roleId` set,
 * the roles are fixed to that one role instead of picked from a list.
 */
import type { AdminUser } from '~/types/security'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{ roleId?: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [AdminUser] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const { data: roleOptions } = useRoleOptions()

// Read-only, just to show the actual number in the password field's
// description instead of a vague "long enough" - changing it is Settings'
// job (Settings → Auth), not this form's.
const { data: authSettings } = useAuthSettings()
const passwordMinLength = computed(() => authSettings.value?.['auth.password_min_length'])
const passwordDescription = computed(() =>
  typeof passwordMinLength.value === 'number'
    ? t('users.userCreate.passwordHelpMin', { n: passwordMinLength.value })
    : t('users.userCreate.passwordHelp')
)

const email = ref('')
const name = ref('')
const password = ref('')
const passwordConfirm = ref('')
const showPassword = ref(false)
const roleIds = ref<string[]>([])
const creating = ref(false)

// The columns the project added to users (Additional data) - set right after the account exists.
const extraApi = useUserExtraColumns()
const { data: extraColumns } = useUserExtraColumnsData()
const extra = ref<Record<string, unknown>>({})
async function writeExtra(userId: string) {
  const refused = await extraApi.write(userId, extra.value)
  if (refused) toast.add({ title: t('users.userEditor.extra.notSet'), description: errorMessage(refused), color: 'warning' })
}

watch(open, (isOpen) => {
  if (!isOpen) return
  email.value = ''
  name.value = ''
  password.value = ''
  passwordConfirm.value = ''
  showPassword.value = false
  roleIds.value = []
  extra.value = {}
}, { immediate: true })

function generate() {
  const length = Math.max(16, typeof passwordMinLength.value === 'number' ? passwordMinLength.value : 16)
  const generated = generatePassword(length)
  password.value = generated
  passwordConfirm.value = generated
  showPassword.value = true
}

// Name and email are both required (every user has an email - it's
// the sign-in identity); the server checks the email's format too.
const canCreate = computed(() => !!name.value.trim() && !!email.value.trim())

async function submit() {
  if (!canCreate.value) return
  if (password.value !== passwordConfirm.value) {
    toast.add({ title: t('users.password.mismatch'), color: 'error' })
    return
  }
  creating.value = true
  try {
    const { data: user } = await api.post<AdminUser>('/users', {
      data: {
        email: email.value,
        name: name.value,
        password: password.value,
        roleIds: props.roleId ? [props.roleId] : roleIds.value
      }
    })
    await writeExtra(user.id)
    toast.add({ title: t('users.userCreate.created'), color: 'success' })
    open.value = false
    emit('created', user)
  } catch (err) {
    notifyError(err, t('users.userCreate.createError'))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('users.roleMembers.newUser')"
    :description="t('users.userCreate.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('common.name')"
          required
        >
          <UInput
            v-model="name"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('users.userEditor.email.label')"
          required
        >
          <UInput
            v-model="email"
            type="email"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('users.userEditor.signIn.password')"
          required
          :description="passwordDescription"
        >
          <UInput
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="w-full"
            :ui="{ base: 'pr-16' }"
          >
            <template #trailing>
              <div class="flex items-center">
                <UTooltip :text="t('users.password.generate')">
                  <UButton
                    icon="i-lucide-wand-sparkles"
                    :aria-label="t('users.password.generate')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    @click="generate"
                  />
                </UTooltip>
                <UTooltip :text="showPassword ? t('users.password.hide') : t('users.password.show')">
                  <UButton
                    :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showPassword ? t('users.password.hidePassword') : t('users.password.showPassword')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    class="ml-1"
                    @click="showPassword = !showPassword"
                  />
                </UTooltip>
              </div>
            </template>
          </UInput>
        </UFormField>
        <UFormField
          :label="t('users.password.confirm')"
          required
          :error="passwordConfirm && password !== passwordConfirm ? t('users.password.mismatchField') : undefined"
        >
          <UInput
            v-model="passwordConfirm"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="w-full"
            :ui="{ base: 'pr-9' }"
          >
            <template #trailing>
              <UTooltip :text="showPassword ? t('users.password.hide') : t('users.password.show')">
                <UButton
                  :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="showPassword ? t('users.password.hidePassword') : t('users.password.showPassword')"
                  color="neutral"
                  variant="link"
                  size="sm"
                  :padded="false"
                  @click="showPassword = !showPassword"
                />
              </UTooltip>
            </template>
          </UInput>
        </UFormField>
        <UFormField
          v-if="!roleId"
          :label="t('common.roles')"
        >
          <USelect
            v-model="roleIds"
            :items="(roleOptions ?? []).map(r => ({ label: r.name, value: r.id }))"
            multiple
            class="w-full"
          />
        </UFormField>
        <template v-if="extraColumns.length">
          <USeparator :label="t('users.userEditor.extra.title')" />
          <UserExtraFields
            v-model="extra"
            :columns="extraColumns"
          />
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="creating"
          @click="open = false"
        />
        <UButton
          :label="t('common.create')"
          :loading="creating"
          :disabled="!canCreate"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
