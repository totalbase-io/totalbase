<script setup lang="ts">
/**
 * Above every page (Security.md §2.21). For administrators: a lockdown is on - so it is never left on unnoticed -
 * or one is scheduled, with the way to its settings. For everyone else inside: one that is on (they hold a role
 * it lets in), or the notice of one about to start (`lockdown.notice_minutes`). Whoever it keeps out is on /lockdown.
 */
const { t } = useI18n()
const session = useSession()
const { refresh } = useInstance()
const lockdown = useLockdown()
const isAdmin = computed(() => session.access.value === 'ADMIN')
const ahead = computed(() => isAdmin.value ? lockdown.scheduled : lockdown.notice)
const shown = computed(() => lockdown.active || ahead.value !== null)
const label = computed(() => {
  const kind = lockdown.readOnly ? 'ReadOnly' : ''
  if (lockdown.active) return lockdown.until ? t(`auth.lockdown.banner${kind}Until`, { time: lockdown.until }) : t(`auth.lockdown.banner${kind}On`)
  if (isAdmin.value) return t(`auth.lockdown.banner${kind}Scheduled`, ahead.value!)
  return [t(`auth.lockdown.banner${kind}Notice`, ahead.value!), lockdown.message].filter(Boolean).join(' ')
})

// A window scheduled, changed or begun since this page loaded: the instance is read again now and then.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    refresh().catch(() => undefined)
  }, 5 * 60_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div
    v-if="shown"
    role="status"
    class="flex items-center gap-2 border-b border-default bg-warning/10 px-4 py-1.5 text-sm"
  >
    <UIcon
      :name="lockdown.active ? 'i-lucide-lock' : 'i-lucide-calendar-clock'"
      class="size-4 shrink-0 text-warning"
    />
    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
    <UButton
      v-if="isAdmin"
      :label="t('auth.lockdown.settings')"
      to="/settings/lockdown"
      size="xs"
      color="neutral"
      variant="outline"
    />
  </div>
</template>
