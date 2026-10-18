<script setup lang="ts">
// The sign-in page (Specification_Admin_UI.md §3.6): one card, four
// layouts chosen by the operator (appearance.login_layout) - SPLIT, TotalBase's
// own panel beside the card (the default); SIMPLE, the company's mark large
// above the card; PANEL, the company's panel beside it; IMAGE, the operator's
// picture with the card left, center or right (M29). The mark, the name and the
// layout come from GET /api/instance (useInstance), read before this page.
import type { AdminAccount } from '~/composables/useSession'
import { useApiErrorMessage } from '~/utils/api-error-message'

definePageMeta({ layout: false })

interface LoginResponse {
  token: string
  admin: AdminAccount
}

const session = useSession()
const { instance } = useInstance()
// An instance with no administrator yet is set up first (pages/setup.vue) - there is no one to sign in.
onMounted(async () => {
  try {
    const { data } = await $fetch<{ data: { required: boolean } }>('/api/setup', { baseURL: '/' })
    if (data.required) await navigateTo('/setup', { replace: true })
  } catch {
    // Not known: the sign-in stays.
  }
})
// IMAGE with no image yet reads as SIMPLE - the card under the mark, never a blank page.
const layout = computed(() => {
  const chosen = instance.value.login.layout
  if (chosen === 'IMAGE' && !instance.value.login.backgroundUrl) return 'SIMPLE'
  return chosen
})
/** The company's own layouts: only a small "Powered by TotalBase" at the foot. */
const ownMark = computed(() => layout.value !== 'SPLIT')
/** IMAGE: where the card sits on a wide screen; its words take the other side (or go above it, centered). */
const position = computed(() => instance.value.login.cardPosition)
const imageWords = computed(() => layout.value === 'IMAGE' && Boolean(instance.value.login.headline || instance.value.login.intro))
const wordsBeside = computed(() => imageWords.value && position.value !== 'CENTER')
const twoColumns = computed(() => layout.value === 'SPLIT' || layout.value === 'PANEL' || wordsBeside.value)
/** IMAGE alone in its row: the card toward its side. */
const cardColumn = computed(() => {
  if (layout.value !== 'IMAGE' || wordsBeside.value) return undefined
  return position.value === 'LEFT' ? 'lg:items-start lg:px-24' : position.value === 'RIGHT' ? 'lg:items-end lg:px-24' : undefined
})
/** The feature list below shows the SAME icons as the admin's own rail (utils/navigation.ts) - one source, so they can't drift apart. */
function navIcon(key: string): string {
  return adminNavGroups.find(group => group.key === key)?.icon ?? 'i-lucide-circle'
}
const api = useAdminApi()
const route = useRoute()
const { t } = useI18n()
const apiErrorMessage = useApiErrorMessage()

const email = ref('')
const password = ref('')
const loading = ref(false)
const errorMessage = ref<string | null>(null)
// The password was right but the email isn't verified yet (EMAIL_NOT_VERIFIED,
// auth.email_verification_required) - offer a new verification link.
const unverifiedEmail = ref<string | null>(null)
const resending = ref(false)
const resent = ref(false)

async function resendVerification() {
  if (!unverifiedEmail.value) return
  resending.value = true
  try {
    // Public, and always answers success - it never tells whether an account exists.
    await $fetch('/api/auth/email/resend', { baseURL: '/', method: 'POST', body: { email: unverifiedEmail.value } })
    resent.value = true
  } catch {
    errorMessage.value = t('auth.login.resendError')
  } finally {
    resending.value = false
  }
}

async function submit() {
  errorMessage.value = null
  unverifiedEmail.value = null
  resent.value = false
  loading.value = true
  try {
    const { data } = await api.post<LoginResponse>('/auth/login', {
      email: email.value,
      password: password.value
    })
    session.setToken(data.token)
    session.admin.value = data.admin
    // The full profile (display preferences included) - best-effort, the
    // sign-in already succeeded.
    await session.refreshProfile().catch(() => undefined)
    // The redirect only applies if it's inside the area this user's access
    // opens - an APP user bounced off an admin URL lands in the app.
    const home = portalHomeFor(data.admin.access)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : home
    await navigateTo(isPortalPathAllowed(redirect, data.admin.access, session.modules.value) ? redirect : home)
  } catch (error) {
    if (error instanceof AdminApiError && error.code === 'EMAIL_NOT_VERIFIED') {
      unverifiedEmail.value = email.value
      return
    }
    // AUTHENTICATION_REQUIRED here is a wrong email or password, not an ended session.
    errorMessage.value = error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED'
      ? t('auth.login.invalidCredentials')
      : apiErrorMessage(error, t('auth.login.signInError'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div
    class="relative flex min-h-screen flex-col bg-default"
    :data-login-layout="layout"
  >
    <!-- IMAGE: the operator's picture under everything, a dark veil so
    the texts over it stay readable whatever the picture. -->
    <template v-if="layout === 'IMAGE'">
      <img
        :src="instance.login.backgroundUrl!"
        alt=""
        class="absolute inset-0 size-full object-cover"
      >
      <div class="absolute inset-0 bg-black/40" />
    </template>

    <!-- Only the switches: every layout carries the mark large, by the card. -->
    <header
      class="relative z-10 flex h-16 shrink-0 items-center justify-end px-6"
      :class="[layout === 'IMAGE' ? 'text-white' : undefined, layout === 'PANEL' || layout === 'SPLIT' ? 'lg:absolute lg:inset-x-0 lg:top-0' : undefined]"
    >
      <div
        class="flex items-center gap-1"
        :class="layout === 'IMAGE' ? 'text-white' : undefined"
      >
        <LanguageButton />
        <UColorModeButton />
      </div>
    </header>

    <main
      class="relative grid flex-1 grid-cols-1"
      :class="twoColumns ? 'lg:grid-cols-2' : undefined"
    >
      <!-- SPLIT: TotalBase's own panel. -->
      <section
        v-if="layout === 'SPLIT'"
        class="hidden flex-col justify-center gap-6 border-r border-default bg-elevated/40 px-16 py-12 lg:flex"
      >
        <UBadge
          color="primary"
          variant="subtle"
          class="w-fit text-xs font-semibold tracking-wide"
        >
          {{ t('auth.login.tagline') }}
        </UBadge>
        <h1 class="text-4xl leading-tight font-bold text-highlighted">
          <i18n-t
            keypath="auth.login.headline"
            tag="span"
          >
            <template #postgresql>
              <span class="text-primary">PostgreSQL</span>
            </template>
          </i18n-t>
        </h1>
        <p class="max-w-md text-muted">
          {{ t('auth.login.intro') }}
        </p>
        <div class="mt-2 flex flex-col gap-4">
          <div class="flex items-start gap-3">
            <UIcon
              name="i-lucide-webhook"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div>
              <p class="font-medium text-highlighted">
                {{ t('auth.login.restApis') }}
              </p>
              <p class="text-sm text-muted">
                {{ t('auth.login.restApisDescription') }}
              </p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <UIcon
              :name="navIcon('dataviews')"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div>
              <p class="font-medium text-highlighted">
                DataViews
              </p>
              <p class="text-sm text-muted">
                {{ t('auth.login.dataviewsDescription') }}
              </p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <UIcon
              :name="navIcon('dashboards')"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div>
              <p class="font-medium text-highlighted">
                Dashboards
              </p>
              <p class="text-sm text-muted">
                {{ t('auth.login.dashboardsDescription') }}
              </p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <UIcon
              :name="navIcon('workflows')"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div>
              <p class="font-medium text-highlighted">
                Workflows
              </p>
              <p class="text-sm text-muted">
                {{ t('auth.login.workflowsDescription') }}
              </p>
            </div>
          </div>
        </div>
        <!-- Under the text, only where the panel has room for it (a tall screen). -->
        <LoginIllustration class="mt-4 hidden w-full max-w-lg [@media(min-height:860px)]:block" />
      </section>

      <!-- PANEL: the company's panel - its mark and words over its picture, else its primary color. Nothing of TotalBase. -->
      <section
        v-else-if="layout === 'PANEL'"
        class="relative hidden flex-col justify-center overflow-hidden px-16 py-12 lg:flex"
        :class="instance.login.backgroundUrl ? undefined : 'bg-primary'"
      >
        <template v-if="instance.login.backgroundUrl">
          <img
            :src="instance.login.backgroundUrl"
            alt=""
            class="absolute inset-0 size-full object-cover"
          >
          <div class="absolute inset-0 bg-black/45" />
        </template>
        <LoginBrand
          class="relative"
          align="start"
          inverse
          headline
          intro
        />
      </section>

      <!-- IMAGE: the operator's own words over the picture, on the side the card leaves. -->
      <section
        v-else-if="wordsBeside"
        class="hidden flex-col justify-center gap-4 px-16 py-12 text-white lg:flex"
        :class="position === 'LEFT' ? 'lg:order-2' : undefined"
      >
        <h1
          v-if="instance.login.headline"
          class="text-4xl leading-tight font-bold"
        >
          {{ instance.login.headline }}
        </h1>
        <p
          v-if="instance.login.intro"
          class="max-w-md text-lg text-white/80"
        >
          {{ instance.login.intro }}
        </p>
      </section>

      <section
        class="flex flex-col items-center justify-center gap-6 px-6 py-12"
        :class="cardColumn"
      >
        <!-- The mark above the card: SPLIT (the operator's logo, else TotalBase's) and SIMPLE always; PANEL and IMAGE on a narrow screen, where their panel and words don't fit (M29). -->
        <LoginBrand
          v-if="layout === 'SPLIT'"
          class="mb-14"
        />
        <LoginBrand
          v-else-if="layout === 'SIMPLE'"
          headline
        />
        <LoginBrand
          v-else-if="layout === 'PANEL' || layout === 'IMAGE'"
          class="lg:hidden"
          :inverse="layout === 'IMAGE'"
          headline
        />
        <!-- IMAGE centered: its words above the card. -->
        <div
          v-if="imageWords && position === 'CENTER'"
          class="hidden max-w-xl flex-col items-center gap-2 text-center text-white lg:flex"
        >
          <h1
            v-if="instance.login.headline"
            class="text-3xl leading-tight font-bold"
          >
            {{ instance.login.headline }}
          </h1>
          <p
            v-if="instance.login.intro"
            class="text-white/80"
          >
            {{ instance.login.intro }}
          </p>
        </div>
        <UCard class="w-full max-w-sm">
          <template #header>
            <!-- IMAGE: the logo and name in the card's own header, on a wide screen. -->
            <BrandMark
              v-if="layout === 'IMAGE'"
              size="lg"
              class="mb-3 max-lg:hidden"
            />
            <div class="flex flex-col gap-1">
              <h2 class="text-lg font-bold text-highlighted">
                {{ t('auth.login.welcome') }}
              </h2>
              <p class="text-sm text-muted">
                {{ t('auth.login.subtitle', { name: instance.name }) }}
              </p>
            </div>
          </template>

          <form
            class="flex flex-col gap-4"
            @submit.prevent="submit"
          >
            <UFormField :label="t('auth.login.email')">
              <UInput
                v-model="email"
                type="email"
                autocomplete="username"
                required
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('auth.login.password')">
              <UInput
                v-model="password"
                type="password"
                autocomplete="current-password"
                required
                class="w-full"
              />
            </UFormField>

            <UAlert
              v-if="errorMessage"
              color="error"
              variant="subtle"
              :title="errorMessage"
            />

            <UAlert
              v-if="unverifiedEmail"
              color="warning"
              variant="subtle"
              :title="t('auth.login.verifyTitle')"
              :description="resent
                ? t('auth.login.verifyResent', { email: unverifiedEmail })
                : t('auth.login.verifyDescription')"
              :actions="resent ? [] : [{ label: t('auth.login.resend'), color: 'warning', variant: 'outline', loading: resending, onClick: resendVerification }]"
            />

            <UButton
              type="submit"
              block
              :loading="loading"
              :label="t('auth.login.signIn')"
            />
          </form>
          <SignInProviders
            :providers="instance.login.providers"
            class="mt-4"
          />
        </UCard>
      </section>
    </main>
    <!-- The company's layouts: what runs underneath, small, at the foot. -->
    <footer
      v-if="ownMark"
      class="relative py-4 text-center text-xs"
      :class="[layout === 'IMAGE' ? 'text-white/70' : 'text-dimmed', layout === 'PANEL' ? 'lg:absolute lg:right-0 lg:bottom-0 lg:w-1/2' : undefined]"
    >
      {{ t('auth.login.poweredBy') }}
    </footer>
  </div>
</template>
