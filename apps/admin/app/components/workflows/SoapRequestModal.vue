<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.soap-request` node's `configuration`
 * (Specification_Workflows.md §5.15.1): the endpoint, the SOAP version,
 * the operation and its namespace, the SOAPAction, and the parameters as
 * a JSON object the server turns into the operation's XML. Every field is
 * literal text/JSON with `{{...}}` support, resolved at run time like HTTP
 * request's. The envelope is never written by hand here - the server
 * builds and escapes it (soap-handlers.ts).
 */
type SoapVersion = '1.1' | '1.2'
export interface SoapRequestConfiguration {
  url?: string
  version?: SoapVersion
  operation?: string
  namespace?: string
  soapAction?: string
  body?: unknown
  soapHeaders?: unknown
  httpHeaders?: unknown
  /** HTTP headers whose value is a secret (Settings > Secrets), read at run time - never stored here. */
  secretHeaders?: { name: string, secret: string }[]
  /** Response elements always parsed as a list, even when they appear once. */
  arrays?: string[]
}

const props = defineProps<{ modelValue: SoapRequestConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: SoapRequestConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const VERSIONS: SoapVersion[] = ['1.1', '1.2']
const url = ref('')
const version = ref<SoapVersion>('1.1')
const operation = ref('')
const namespace = ref('')
const soapAction = ref('')
const bodyJson = ref('{}')
const soapHeadersJson = ref('{}')
const httpHeadersJson = ref('{}')
const arraysText = ref('')
const secretHeaders = ref<{ name: string, secret: string }[]>([])
const api = useAdminApi()
const { data: secretKeys } = useAsyncData('soap-request-secrets', () => api.get<{ key: string }[]>('/secrets').then(r => r.data.map(s => s.key)), { default: () => [] })
const secretHeadersValid = computed(() => secretHeaders.value.every(h => h.name.trim() && h.secret))

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  url.value = props.modelValue.url ?? ''
  version.value = props.modelValue.version ?? '1.1'
  operation.value = props.modelValue.operation ?? ''
  namespace.value = props.modelValue.namespace ?? ''
  soapAction.value = props.modelValue.soapAction ?? ''
  bodyJson.value = JSON.stringify(props.modelValue.body ?? {}, null, 2)
  soapHeadersJson.value = JSON.stringify(props.modelValue.soapHeaders ?? {}, null, 2)
  httpHeadersJson.value = JSON.stringify(props.modelValue.httpHeaders ?? {}, null, 2)
  arraysText.value = (props.modelValue.arrays ?? []).join(', ')
  secretHeaders.value = (props.modelValue.secretHeaders ?? []).map(h => ({ ...h }))
})

const bodyError = computed(() => jsonError(bodyJson.value))
const soapHeadersError = computed(() => jsonError(soapHeadersJson.value))
const httpHeadersError = computed(() => jsonError(httpHeadersJson.value))
const valid = computed(() => !!url.value.trim() && !!operation.value.trim() && !!namespace.value.trim() && keyValid.value && !bodyError.value && !soapHeadersError.value && !httpHeadersError.value && secretHeadersValid.value)

function save() {
  if (!valid.value) return
  const arrays = arraysText.value.split(',').map(s => s.trim()).filter(Boolean)
  const soapHeaders = JSON.parse(soapHeadersJson.value)
  const httpHeaders = JSON.parse(httpHeadersJson.value)
  emit('save', {
    key: keyValue.value,
    configuration: {
      url: url.value.trim(),
      version: version.value,
      operation: operation.value.trim(),
      namespace: namespace.value.trim(),
      soapAction: soapAction.value.trim(),
      body: JSON.parse(bodyJson.value),
      ...(soapHeaders && Object.keys(soapHeaders).length > 0 ? { soapHeaders } : {}),
      ...(httpHeaders && Object.keys(httpHeaders).length > 0 ? { httpHeaders } : {}),
      ...(secretHeaders.value.length > 0 ? { secretHeaders: secretHeaders.value.map(h => ({ name: h.name.trim(), secret: h.secret })) } : {}),
      ...(arrays.length > 0 ? { arrays } : {})
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
    :title="$t('workflows.soapRequestModal.soapRequest')"
    :description="$t('workflows.soapRequestModal.callASoapWebService')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.soapRequestModal.url')"
          required
          :description="$t('workflows.soapRequestModal.theServiceEndpoint', { c0: '{{...}}' })"
        >
          <UInput
            v-model="url"
            class="w-full font-mono"
          />
        </UFormField>

        <div class="flex gap-4 max-md:flex-col">
          <UFormField
            :label="$t('workflows.soapRequestModal.version')"
            class="w-36 max-md:w-full"
          >
            <USelect
              v-model="version"
              :items="VERSIONS"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="$t('workflows.soapRequestModal.operation')"
            required
            class="flex-1"
            :description="$t('workflows.soapRequestModal.theOperationsElementName')"
          >
            <UInput
              v-model="operation"
              class="w-full font-mono"
            />
          </UFormField>
        </div>

        <UFormField
          :label="$t('workflows.soapRequestModal.namespace')"
          required
          :description="$t('workflows.soapRequestModal.theOperationsXmlNamespace')"
        >
          <UInput
            v-model="namespace"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.soapAction')"
          :description="$t('workflows.soapRequestModal.theSoapActionHeader')"
        >
          <UInput
            v-model="soapAction"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.body')"
          :description="$t('workflows.soapRequestModal.aJsonObjectTheParameters', { c0: '{{...}}' })"
          :error="bodyError ?? undefined"
        >
          <JsonEditor
            v-model="bodyJson"
            min-height="10rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.arrays')"
          :description="$t('workflows.soapRequestModal.elementsAlwaysReadAsAList')"
        >
          <UInput
            v-model="arraysText"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.soapHeaders')"
          :description="$t('workflows.soapRequestModal.aJsonObjectSentInTheEnvelopesHeader', { c0: '{{...}}' })"
          :error="soapHeadersError ?? undefined"
        >
          <JsonEditor
            v-model="soapHeadersJson"
            min-height="6rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.httpHeaders')"
          :description="$t('workflows.soapRequestModal.aJsonObjectHttpHeaderNames', { c0: '{{...}}' })"
          :error="httpHeadersError ?? undefined"
        >
          <JsonEditor
            v-model="httpHeadersJson"
            min-height="6rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.soapRequestModal.secretHeaders')"
          :description="$t('workflows.soapRequestModal.httpHeadersWhoseValueIsA')"
        >
          <div class="flex flex-col gap-2">
            <div
              v-for="(header, index) in secretHeaders"
              :key="index"
              class="flex items-center gap-2 max-md:flex-col max-md:items-stretch"
            >
              <UInput
                v-model="header.name"
                class="flex-1 font-mono"
                :aria-label="$t('workflows.soapRequestModal.secretHeaderName', { n: index + 1 })"
              />
              <USelectMenu
                v-model="header.secret"
                :items="secretKeys ?? []"
                class="flex-1"
                :aria-label="$t('workflows.soapRequestModal.secretHeaderSecret', { n: index + 1 })"
              />
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                :aria-label="$t('workflows.soapRequestModal.removeSecretHeader', { n: index + 1 })"
                @click="secretHeaders.splice(index, 1)"
              />
            </div>
            <div>
              <UButton
                :label="$t('workflows.soapRequestModal.addASecretHeader')"
                icon="i-lucide-plus"
                size="xs"
                color="neutral"
                variant="outline"
                @click="secretHeaders.push({ name: '', secret: '' })"
              />
            </div>
          </div>
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
