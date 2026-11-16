<script setup lang="ts">
import type { Resource } from '~/types/resource'
import type { RelationDetail } from '~/types/schema'

/**
 * A resource page's Danger zone - last of all, its own tinted panel so it reads as a higher-stakes area: Delete,
 * disabled with the reason when TotalBase's role doesn't own the object (Administration.md §3.15), confirmed in a
 * modal with Cascade. Once dropped, the resources list and the sidebar's schemas refresh and the page goes back.
 */
const props = defineProps<{
  resource: Resource
  /** From the page's catalog read; unknown (null) disables nothing on a guess. */
  ownership: Pick<RelationDetail, 'owner' | 'canAlter'> | null
}>()
const { t } = useI18n()
const api = useAdminApi()
const toast = useToast()
const notifyError = useErrorToast()
const router = useRouter()

const kind = computed(() => props.resource.type.toLowerCase() as 'table' | 'view' | 'function')
const key = (name: string) => t(`database.${kind.value}ResourceDetail.${name}`)
const notOwned = computed(() => props.ownership?.canAlter === false)
const qualified = computed(() => `${props.resource.schema}.${props.resource.name}`)

const open = ref(false)
const cascade = ref(false)
const dropping = ref(false)
function openDrop() {
  cascade.value = false
  open.value = true
}
async function drop() {
  const { schema, name, id, type } = props.resource
  const qs = cascade.value ? '?cascade=true' : ''
  dropping.value = true
  try {
    if (type === 'TABLE') await api.del(`/schema/${schema}/tables/${name}${qs}`)
    else if (type === 'VIEW') await api.del(`/schema/views/${id}${qs}`)
    else await api.del(`/schema/functions/${id}${qs}`)
    toast.add({ title: key('deleted'), color: 'success' })
    open.value = false
    // The registry and the schemas DatabaseTree.vue reads - a layout sibling, reached through the shared keys.
    await Promise.all([refreshResourcesList(), refreshSchemasList()])
    router.back()
  } catch (err) {
    notifyError(err, t(`database.${kind.value}ResourceDetail.deleteError`))
  } finally {
    dropping.value = false
  }
}
</script>

<template>
  <section class="rounded-lg bg-error/10 p-5 flex flex-col gap-3">
    <div>
      <p class="font-semibold">
        {{ key('deleteTitle') }}
      </p>
      <p class="text-sm text-muted mt-1">
        {{ t('database.resourceDetail.permanentlyDeletes', { name: qualified }) }}
      </p>
    </div>
    <NotOwnedNote
      v-if="notOwned"
      :kind="kind"
      :owner="ownership!.owner"
    />
    <UButton
      :label="key('deleteButton')"
      color="error"
      variant="soft"
      class="self-start"
      :disabled="notOwned"
      @click="openDrop"
    />
    <DeleteConfirmModal
      v-model:open="open"
      :title="key('deleteModalTitle')"
      :loading="dropping"
      @confirm="drop"
    >
      <i18n-t
        keypath="database.resourceDetail.dropBody"
        tag="p"
        class="text-sm text-muted"
      >
        <template #name>
          <span class="font-mono text-default">{{ qualified }}</span>
        </template>
      </i18n-t>
      <USwitch
        v-model="cascade"
        :label="t('database.resourceDetail.cascade')"
      />
    </DeleteConfirmModal>
  </section>
</template>
