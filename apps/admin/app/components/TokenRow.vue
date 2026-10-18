<script setup lang="ts">
/**
 * One personal access token as a list row - name and description, access,
 * prefix, last use and expiry (amber when expiring, red once past), dimmed
 * once it can't authenticate. The same row in a user's Tokens tab and on
 * the global API tokens page (grouped by user there, with a checkbox for
 * bulk actions). Actions come in through `actions` (the "⋯" menu).
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { UserApiToken } from '~/types/security'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

defineProps<{
  token: UserApiToken
  actions: DropdownMenuItem[][]
  /** Shows a checkbox (bulk actions) - v-model:selected. */
  selectable?: boolean
}>()
const selected = defineModel<boolean>('selected', { default: false })

const { t } = useI18n()
const { tokenState, usable, expiryText, lastUsedText } = useTokenStatus()
</script>

<template>
  <div class="flex items-start gap-3 px-4 py-3">
    <UCheckbox
      v-if="selectable"
      v-model="selected"
      class="mt-0.5"
      :aria-label="t('users.common.selectUser', { user: token.name })"
    />
    <UIcon
      name="i-lucide-key-round"
      class="mt-0.5 size-5 shrink-0"
      :class="usable(token) ? 'text-muted' : 'text-dimmed'"
    />
    <div
      class="flex min-w-0 flex-1 flex-col gap-0.5"
      :class="usable(token) ? undefined : 'opacity-60'"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-highlighted">{{ token.name }}</span>
        <UBadge
          :label="token.plane === 'ADMIN' ? t('users.tokens.adminApi') : t('users.tokens.dataApi')"
          :color="token.plane === 'ADMIN' ? 'warning' : 'neutral'"
          variant="subtle"
          size="sm"
        />
        <UBadge
          v-if="!usable(token)"
          :label="t(TOKEN_STATE_BADGE[tokenState(token)].labelKey)"
          :color="TOKEN_STATE_BADGE[tokenState(token)].color"
          variant="subtle"
          size="sm"
        />
        <code class="text-xs text-muted">{{ token.keyPrefix }}…</code>
      </div>
      <p
        v-if="token.description"
        class="truncate text-sm text-muted"
        :title="token.description"
      >
        {{ token.description }}
      </p>
      <p class="text-xs text-muted">
        {{ lastUsedText(token) }} ·
        <span :class="TOKEN_EXPIRY_CLASS[tokenState(token)]">{{ expiryText(token) }}</span>
        · {{ t('users.tokens.createdOn', { date: dates.date(token.createdAt, TOKEN_DAY) }) }}
      </p>
    </div>
    <UDropdownMenu
      :items="actions"
      :content="{ align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis-vertical"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="t('users.roleEditor.rowActions', { name: token.name })"
      />
    </UDropdownMenu>
  </div>
</template>
