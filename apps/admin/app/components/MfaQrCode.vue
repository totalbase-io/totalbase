<script setup lang="ts">
/**
 * An authenticator app's setup (Security.md §2.17): the `otpauth://` link as a QR code to scan, and the
 * secret as text beside it for an app that can't scan. Drawn in the browser - the link never leaves it.
 */
import QRCode from 'qrcode'

const props = defineProps<{
  otpauthUrl: string
  secret: string
}>()

const { t } = useI18n()
const toast = useToast()
const image = ref<string | null>(null)

async function copySecret() {
  await navigator.clipboard.writeText(props.secret)
  toast.add({ title: t('common.copied'), color: 'success' })
}

watch(() => props.otpauthUrl, async (url) => {
  image.value = await QRCode.toDataURL(url, { margin: 1, width: 192, errorCorrectionLevel: 'M' })
}, { immediate: true })

/** In groups of four, the way apps show it - easier to type. */
const grouped = computed(() => props.secret.match(/.{1,4}/g)?.join(' ') ?? props.secret)
</script>

<template>
  <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
    <img
      v-if="image"
      :src="image"
      :alt="t('auth.mfa.qrAlt')"
      class="size-48 shrink-0 rounded-md bg-white"
    >
    <div class="flex flex-col gap-2 text-sm">
      <p class="text-muted">
        {{ t('auth.mfa.scan') }}
      </p>
      <p class="text-muted">
        {{ t('auth.mfa.typeSecret') }}
      </p>
      <div class="flex items-center gap-2">
        <code class="rounded-md bg-elevated px-2 py-1 font-mono text-sm break-all text-highlighted">{{ grouped }}</code>
        <UButton
          :aria-label="t('common.copy')"
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          size="xs"
          square
          @click="copySecret"
        />
      </div>
    </div>
  </div>
</template>
