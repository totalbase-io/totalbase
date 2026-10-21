<script setup lang="ts">
/**
 * The ten recovery codes, shown once (Security.md §2.17): each signs in a single time when the phone is
 * lost. Copy or download them before going on - TotalBase keeps only their hashes.
 */
const props = defineProps<{
  codes: string[]
}>()

const { t } = useI18n()
const toast = useToast()
const { instance } = useInstance()

const text = computed(() => `${t('auth.mfa.codesFileTitle', { name: instance.value.name })}\n\n${props.codes.join('\n')}\n`)

async function copy() {
  await navigator.clipboard.writeText(text.value)
  toast.add({ title: t('common.copied'), color: 'success' })
}

function download() {
  const url = URL.createObjectURL(new Blob([text.value], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'recovery-codes.txt'
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('auth.mfa.codesTitle')"
      :description="t('auth.mfa.codesDescription')"
    />
    <ul class="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-default p-4 font-mono text-sm text-highlighted">
      <li
        v-for="code in codes"
        :key="code"
      >
        {{ code }}
      </li>
    </ul>
    <div class="flex gap-2">
      <UButton
        :label="t('common.copy')"
        icon="i-lucide-copy"
        color="neutral"
        variant="outline"
        size="sm"
        @click="copy"
      />
      <UButton
        :label="t('auth.mfa.download')"
        icon="i-lucide-download"
        color="neutral"
        variant="outline"
        size="sm"
        @click="download"
      />
    </div>
  </div>
</template>
