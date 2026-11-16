<script setup lang="ts">
import type { Resource } from '~/types/resource'
import { methodColor } from '~/utils/resource-endpoints'
import { useApiErrorMessage } from '~/utils/api-error-message'

/**
 * A table's, view's or function's page frame (Admin_UI.md §5.1): the header with the methods it exposes, the
 * load error, the loading state, and the sections stacked top to bottom in one scrolling column - the default slot,
 * given the loaded resource. Modals go in `overlays`.
 */
defineProps<{
  resource: Resource | null | undefined
  pending: boolean
  error: unknown
  /** The load error's title - "Could not load this table". */
  loadError: string
}>()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
</script>

<template>
  <PageShell>
    <template
      v-if="!error"
      #header
    >
      <PageHeader
        :title="resource?.name ?? ''"
        :description="resource?.description ?? undefined"
        :icon="resource ? RESOURCE_TYPE_STYLE[resource.type].icon : undefined"
      >
        <template #center>
          <UBadge
            v-for="method in resource?.exposedMethods ?? []"
            :key="method"
            :color="methodColor(method)"
            variant="subtle"
            size="xs"
          >
            {{ method }}
          </UBadge>
          <span
            v-if="!resource?.exposedMethods.length"
            class="text-xs text-muted"
          >
            {{ t('database.resourceDetail.notExposed') }}
          </span>
        </template>
      </PageHeader>
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="loadError"
      :description="errorMessage(error, t('database.resourceDetail.loadErrorDescription'))"
    />

    <template v-else>
      <UEmpty
        v-if="pending || !resource"
        loading
        variant="naked"
        size="sm"
      />
      <div
        v-else
        class="flex flex-1 min-h-0 flex-col overflow-y-auto"
      >
        <div class="mx-auto flex w-[95%] flex-col gap-8 pb-12 md:w-3/4">
          <slot :resource="resource" />
        </div>
      </div>
    </template>

    <slot name="overlays" />
  </PageShell>
</template>
