<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.http-request` node's `configuration`: method,
 * URL, headers, and `body` for an outbound call to an external API. `url`
 * is a literal string, `headers`/`body` literal JSON - all three can
 * contain `{{operation.data.field}}` expressions (apps/server/src/
 * workflow-execution/templates.ts), resolved at run time against any
 * other step (Start included, as `{{start.data...}}`). Reverted from the
 * earlier structured-Binding picker (WorkflowBindingField.vue) once the
 * chat established `{{...}}` as the one cross-catalog convention - same
 * reasoning as CreateRecordsModal.vue's own doc comment. `url`/`headers`
 * must resolve to a string/object respectively (enforced server-side in
 * code-handlers.ts's `httpRequest`).
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export interface HttpRequestConfiguration {
  method?: HttpMethod
  url?: string
  headers?: unknown
  /** Headers whose value is a secret (Settings > Secrets), read at run time - never stored here. */
  secretHeaders?: { name: string, secret: string }[]
  body?: unknown
}

const props = defineProps<{ modelValue: HttpRequestConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: HttpRequestConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const method = ref<HttpMethod>('GET')
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
// Secret headers (Workflows.md §5.15): a header named here takes a secret's value at run time.
const secretHeaders = ref<{ name: string, secret: string }[]>([])
const api = useAdminApi()
const { data: secretKeys } = useAsyncData('http-request-secrets', () => api.get<{ key: string }[]>('/secrets').then(r => r.data.map(s => s.key)), { default: () => [] })
const secretHeadersValid = computed(() => secretHeaders.value.every(h => h.name.trim() && h.secret))
const url = ref('')
const headersJson = ref('{}')
const bodyJson = ref('null')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  method.value = props.modelValue.method ?? 'GET'
  url.value = props.modelValue.url ?? ''
  headersJson.value = JSON.stringify(props.modelValue.headers ?? {}, null, 2)
  bodyJson.value = JSON.stringify(props.modelValue.body ?? null, null, 2)
  secretHeaders.value = (props.modelValue.secretHeaders ?? []).map(h => ({ ...h }))
})

const headersError = computed(() => jsonError(headersJson.value))
const bodyError = computed(() => jsonError(bodyJson.value))

function save() {
  if (headersError.value || bodyError.value || !secretHeadersValid.value) return
  emit('save', {
    key: keyValue.value,
    configuration: {
      method: method.value,
      url: url.value,
      headers: JSON.parse(headersJson.value),
      ...(secretHeaders.value.length > 0 ? { secretHeaders: secretHeaders.value.map(h => ({ name: h.name.trim(), secret: h.secret })) } : {}),
      body: JSON.parse(bodyJson.value)
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
    :title="$t('workflows.httpRequestModal.httpRequest')"
    :description="$t('workflows.httpRequestModal.callAnExternalApi')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.httpRequestModal.method')"
          class="w-36"
        >
          <USelect
            v-model="method"
            :items="METHODS"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.httpRequestModal.url')"
          required
          :description="$t('workflows.httpRequestModal.anHttpOrHttpsUrl', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
        >
          <UInput
            v-model="url"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.httpRequestModal.headers')"
          :description="$t('workflows.httpRequestModal.aJsonObjectHeaderNames', { c0: '{{...}}' })"
          :error="headersError ?? undefined"
        >
          <JsonEditor
            v-model="headersJson"
            min-height="8rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.httpRequestModal.secretHeaders')"
          :description="$t('workflows.httpRequestModal.headersWhoseValueIsA')"
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
                :aria-label="$t('workflows.httpRequestModal.secretHeaderName', { n: index + 1 })"
              />
              <USelectMenu
                v-model="header.secret"
                :items="secretKeys ?? []"
                class="flex-1"
                :aria-label="$t('workflows.httpRequestModal.secretHeaderSecret', { n: index + 1 })"
              />
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                :aria-label="$t('workflows.httpRequestModal.removeSecretHeader', { n: index + 1 })"
                @click="secretHeaders.splice(index, 1)"
              />
            </div>
            <div>
              <UButton
                :label="$t('workflows.httpRequestModal.addASecretHeader')"
                icon="i-lucide-plus"
                size="xs"
                color="neutral"
                variant="outline"
                @click="secretHeaders.push({ name: '', secret: '' })"
              />
            </div>
          </div>
        </UFormField>

        <UFormField
          :label="$t('workflows.httpRequestModal.body')"
          :description="$t('workflows.httpRequestModal.sentAsTheRequestBody', { c0: '{{...}}' })"
          :error="bodyError ?? undefined"
        >
          <JsonEditor
            v-model="bodyJson"
            min-height="8rem"
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
          :disabled="!url || !keyValid || !!headersError || !!bodyError || !secretHeadersValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
