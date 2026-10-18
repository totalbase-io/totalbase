<script setup lang="ts">
/**
 * Settings > MCP (Specification_Administration.md §11.7): the generic
 * settings form, and above it how an agent connects - the address the
 * server answers at (this instance's public URL + /mcp), ready-to-paste
 * configuration for Claude Code, and where its token comes from (an
 * administrator's plane="ADMIN" personal access token).
 */
const { t } = useI18n()
const api = useAdminApi()
const toast = useToast()

const { data: publicUrl } = await useAsyncData('settings-mcp-public-url', async () => {
  const system = (await api.get<Record<string, unknown>>('/settings/system')).data
  return typeof system['system.public_url'] === 'string' ? system['system.public_url'] : ''
})
const endpoint = computed(() => `${(publicUrl.value || (import.meta.client ? window.location.origin : '')).replace(/\/$/, '')}/mcp`)

const claudeCode = computed(() => `claude mcp add --transport http totalbase ${endpoint.value} --header "Authorization: Bearer $TOTALBASE_TOKEN"`)
const mcpJson = computed(() => JSON.stringify({
  mcpServers: {
    totalbase: { type: 'http', url: endpoint.value, headers: { Authorization: 'Bearer ${TOTALBASE_TOKEN}' } }
  }
}, null, 2))

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title: t('settings.mcp.copied'), color: 'success' })
}
</script>

<template>
  <SettingsGroupForm group="mcp">
    <template #intro="{ settings }">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-semibold">
              {{ t('settings.mcp.connection') }}
            </h3>
            <UBadge
              :label="settings?.['mcp.enabled'] ? t('settings.mcp.on') : t('settings.mcp.off')"
              :color="settings?.['mcp.enabled'] ? 'success' : 'neutral'"
              variant="subtle"
            />
          </div>
        </template>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('settings.mcp.address')"
            :description="t('settings.mcp.addressHelp')"
          >
            <UInput
              :model-value="endpoint"
              readonly
              class="w-full font-mono"
              :aria-label="t('settings.mcp.address')"
            >
              <template #trailing>
                <UButton
                  icon="i-lucide-copy"
                  :aria-label="t('settings.mcp.copy')"
                  color="neutral"
                  variant="link"
                  size="xs"
                  @click="copy(endpoint)"
                />
              </template>
            </UInput>
          </UFormField>
          <UFormField
            :label="t('settings.mcp.token')"
            :description="t('settings.mcp.tokenHelp')"
          >
            <UButton
              icon="i-lucide-key-round"
              :label="t('settings.mcp.createToken')"
              to="/account?tab=tokens"
              color="neutral"
              variant="outline"
            />
          </UFormField>
          <UFormField
            :label="t('settings.mcp.claudeCode')"
            :description="t('settings.mcp.claudeCodeHelp')"
          >
            <div class="relative">
              <pre class="overflow-x-auto rounded-md border border-default bg-elevated p-3 pr-10 font-mono text-xs">{{ claudeCode }}</pre>
              <UButton
                icon="i-lucide-copy"
                :aria-label="t('settings.mcp.copy')"
                color="neutral"
                variant="ghost"
                size="xs"
                class="absolute top-2 right-2"
                @click="copy(claudeCode)"
              />
            </div>
          </UFormField>
          <UFormField
            :label="t('settings.mcp.mcpJson')"
            :description="t('settings.mcp.mcpJsonHelp')"
          >
            <div class="relative">
              <pre class="overflow-x-auto rounded-md border border-default bg-elevated p-3 pr-10 font-mono text-xs">{{ mcpJson }}</pre>
              <UButton
                icon="i-lucide-copy"
                :aria-label="t('settings.mcp.copy')"
                color="neutral"
                variant="ghost"
                size="xs"
                class="absolute top-2 right-2"
                @click="copy(mcpJson)"
              />
            </div>
          </UFormField>
        </div>
      </UCard>
    </template>
  </SettingsGroupForm>
</template>
