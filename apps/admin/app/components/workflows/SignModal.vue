<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.sign` node's `configuration`
 * (Workflows.md §5.15.2): the text to sign (with `{{...}}`) and, for CMS,
 * the secrets holding the certificate, its private key and, when the key is
 * encrypted, its passphrase - for HMAC-SHA256, the secret holding the key and
 * the signature's encoding. Only the secrets' names are stored - their values
 * are read when the step runs.
 */
export interface SignConfiguration {
  format?: 'CMS' | 'HMAC_SHA256'
  data?: string
  certificate?: string
  privateKey?: string
  passphrase?: string
  key?: string
  encoding?: 'HEX' | 'BASE64'
}

const props = defineProps<{ modelValue: SignConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: SignConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const FORMATS = [{ label: 'CMS / PKCS#7', value: 'CMS' as const }, { label: 'HMAC-SHA256', value: 'HMAC_SHA256' as const }]
const ENCODINGS = [{ label: 'Hex', value: 'HEX' as const }, { label: 'Base64', value: 'BASE64' as const }]
const format = ref<'CMS' | 'HMAC_SHA256'>('CMS')
const data = ref('')
const certificate = ref('')
const privateKey = ref('')
const passphrase = ref<string | undefined>(undefined)
const key = ref('')
const encoding = ref<'HEX' | 'BASE64'>('HEX')
const hmac = computed(() => format.value === 'HMAC_SHA256')
const api = useAdminApi()
const { data: secretKeys } = useAsyncData('sign-secrets', () => api.get<{ key: string }[]>('/secrets').then(r => r.data.map(s => s.key)), { default: () => [] })

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  format.value = props.modelValue.format ?? 'CMS'
  data.value = props.modelValue.data ?? ''
  certificate.value = props.modelValue.certificate ?? ''
  privateKey.value = props.modelValue.privateKey ?? ''
  passphrase.value = props.modelValue.passphrase
  key.value = props.modelValue.key ?? ''
  encoding.value = props.modelValue.encoding ?? 'HEX'
})

const valid = computed(() => keyValid.value && !!data.value && (hmac.value ? !!key.value : !!certificate.value && !!privateKey.value))

function save() {
  if (!valid.value) return
  emit('save', {
    key: keyValue.value,
    configuration: hmac.value
      ? { format: format.value, data: data.value, key: key.value, encoding: encoding.value }
      : {
          format: format.value,
          data: data.value,
          certificate: certificate.value,
          privateKey: privateKey.value,
          ...(passphrase.value ? { passphrase: passphrase.value } : {})
        }
  })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.signModal.sign')"
    :description="$t('workflows.signModal.signDataWithAStoredCertificate')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.signModal.format')"
          :description="$t(hmac ? 'workflows.signModal.hmacDescription' : 'workflows.signModal.cmsDescription')"
          class="w-60 max-md:w-full"
        >
          <USelect
            v-model="format"
            :items="FORMATS"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.signModal.data')"
          required
          :description="$t('workflows.signModal.theTextToSign', { c0: '{{build_ticket.data}}' })"
        >
          <UTextarea
            v-model="data"
            :rows="4"
            autoresize
            class="w-full font-mono"
          />
        </UFormField>

        <div
          v-if="hmac"
          class="flex gap-4 max-md:flex-col"
        >
          <UFormField
            :label="$t('workflows.signModal.key')"
            required
            class="flex-1"
            :description="$t('workflows.signModal.aSecretHoldingTheKey')"
          >
            <USelectMenu
              v-model="key"
              :items="secretKeys ?? []"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="$t('workflows.signModal.encoding')"
            class="flex-1"
            :description="$t('workflows.signModal.encodingDescription')"
          >
            <USelect
              v-model="encoding"
              :items="ENCODINGS"
              class="w-full"
            />
          </UFormField>
        </div>

        <div
          v-if="!hmac"
          class="flex gap-4 max-md:flex-col"
        >
          <UFormField
            :label="$t('workflows.signModal.certificate')"
            required
            class="flex-1"
            :description="$t('workflows.signModal.aSecretHoldingThePemCertificate')"
          >
            <USelectMenu
              v-model="certificate"
              :items="secretKeys ?? []"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="$t('workflows.signModal.privateKey')"
            required
            class="flex-1"
            :description="$t('workflows.signModal.aSecretHoldingThePemKey')"
          >
            <USelectMenu
              v-model="privateKey"
              :items="secretKeys ?? []"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          v-if="!hmac"
          :label="$t('workflows.signModal.passphrase')"
          :description="$t('workflows.signModal.onlyWhenTheKeyIsEncrypted')"
          class="md:w-1/2"
        >
          <USelectMenu
            v-model="passphrase"
            :items="secretKeys ?? []"
            clear
            class="w-full"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          :disabled="!valid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
