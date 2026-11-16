<script setup lang="ts">
import type { Resource } from '~/types/resource'

/**
 * A view's or function's Edit: its definition (the catalog's DDL) opened in the SQL Console to change and run -
 * TotalBase has no visual view or function editor (AGENTS.md §3).
 */
const props = defineProps<{ resource: Resource, label: string }>()
const { t } = useI18n()
const api = useAdminApi()
const notifyError = useErrorToast()

const open = ref(false)
const sql = ref('')
const editingLabel = ref('')
const loading = ref(false)
async function openConsole() {
  const kind = props.resource.type.toLowerCase()
  loading.value = true
  try {
    const { data } = await api.get<{ ddl: string }>(`/catalog/${kind}/${props.resource.id}/ddl`)
    sql.value = data.ddl
    editingLabel.value = `${props.resource.schema}.${props.resource.name}`
    open.value = true
  } catch (err) {
    notifyError(err, t(`database.${kind}ResourceDetail.definitionLoadError`))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UButton
    :label="label"
    icon="i-lucide-square-terminal"
    color="primary"
    variant="solid"
    :loading="loading"
    @click="openConsole"
  />
  <SqlConsoleDrawer
    v-model:open="open"
    mode="edit"
    :initial-sql="sql"
    :editing-label="editingLabel"
  />
</template>
