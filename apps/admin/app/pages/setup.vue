<script setup lang="ts">
/**
 * The first-start setup (Foundations.md §14.1): an instance with no administrator asks for the code its server
 * wrote to the log (the link carries it), then the first administrator, the public URL and the language - and
 * signs them in. Public; once an administrator exists the server answers 404 and this page sends to sign in.
 */
import type { AdminAccount } from '~/composables/useSession'
import { UI_LANGUAGES, type UiLanguage } from '@totalbase/shared'

definePageMeta({ layout: false })

const { t, te, locale } = useI18n()
const route = useRoute()
const session = useSession()
const api = useAdminApi()

const checking = ref(true)
const code = ref(typeof route.query.code === 'string' ? route.query.code : '')
const codeFromLink = code.value !== ''
const name = ref('')
const email = ref('')
const password = ref('')
const passwordConfirm = ref('')
const showPassword = ref(false)
const publicUrl = ref(import.meta.client ? window.location.origin : '')
const language = ref<UiLanguage>(UI_LANGUAGES.find(l => l.code === locale.value)?.code ?? 'en')
const submitting = ref(false)
const errorMessage = ref<string | null>(null)

onMounted(async () => {
  try {
    const { data } = await $fetch<{ data: { required: boolean } }>('/api/setup', { baseURL: '/' })
    if (!data.required) {
      await navigateTo('/login', { replace: true })
      return
    }
  } catch {
    // The check failed: the form stays, and the server decides on submit.
  }
  checking.value = false
})

const mismatch = computed(() => !!passwordConfirm.value && password.value !== passwordConfirm.value)
const languageItems = UI_LANGUAGES.map(l => ({ label: l.name, value: l.code }))

async function submit() {
  errorMessage.value = null
  if (password.value !== passwordConfirm.value) {
    errorMessage.value = t('auth.tokenPassword.mustMatch')
    return
  }
  submitting.value = true
  try {
    await $fetch('/api/setup', {
      baseURL: '/',
      method: 'POST',
      body: { data: { code: code.value, name: name.value, email: email.value, password: password.value, publicUrl: publicUrl.value, language: language.value } }
    })
    // Signed in at once, as the administrator just created.
    const { data } = await api.post<{ admin: AdminAccount }>('/auth/login', { email: email.value, password: password.value, mode: 'session' })
    session.admin.value = data.admin
    await session.refreshProfile().catch(() => undefined)
    await navigateTo('/status')
  } catch (err) {
    const first = (err as { data?: { errors?: Array<{ code?: string, message?: string }> } }).data?.errors?.[0]
    errorMessage.value = first?.code && te(`errors.${first.code}`) ? t(`errors.${first.code}`) : first?.message ?? t('auth.genericError')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPublicCard>
    <UEmpty
      v-if="checking"
      loading
      variant="naked"
      size="sm"
    />
    <form
      v-else
      class="flex flex-col gap-4"
      @submit.prevent="submit"
    >
      <div class="flex flex-col gap-1">
        <h1 class="text-lg font-semibold text-highlighted">
          {{ t('auth.setup.title') }}
        </h1>
        <p class="text-sm text-muted">
          {{ t('auth.setup.description') }}
        </p>
      </div>
      <UFormField
        v-if="!codeFromLink"
        :label="t('auth.setup.code')"
        :description="t('auth.setup.codeHelp')"
        required
      >
        <UInput
          v-model="code"
          autocomplete="off"
          class="w-full font-mono"
        />
      </UFormField>
      <UFormField
        :label="t('auth.setup.name')"
      >
        <UInput
          v-model="name"
          autocomplete="name"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t('auth.setup.email')"
        required
      >
        <UInput
          v-model="email"
          type="email"
          autocomplete="email"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t('auth.tokenPassword.newPassword')"
        required
      >
        <UInput
          v-model="password"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="new-password"
          class="w-full"
          :ui="{ base: 'pr-9' }"
        >
          <template #trailing>
            <UButton
              :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="showPassword ? t('auth.tokenPassword.hidePassword') : t('auth.tokenPassword.showPassword')"
              color="neutral"
              variant="link"
              size="sm"
              :padded="false"
              @click="showPassword = !showPassword"
            />
          </template>
        </UInput>
      </UFormField>
      <UFormField
        :label="t('auth.tokenPassword.confirmPassword')"
        required
        :error="mismatch ? t('auth.tokenPassword.mismatch') : undefined"
      >
        <UInput
          v-model="passwordConfirm"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="new-password"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t('auth.setup.publicUrl')"
        :description="t('auth.setup.publicUrlHelp')"
      >
        <UInput
          v-model="publicUrl"
          type="url"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('auth.setup.language')">
        <USelect
          v-model="language"
          :items="languageItems"
          class="w-full"
        />
      </UFormField>
      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        :title="errorMessage"
      />
      <UButton
        type="submit"
        :label="t('auth.setup.submit')"
        :loading="submitting"
        :disabled="!code || !email || !password || mismatch"
        block
      />
    </form>
  </AuthPublicCard>
</template>
