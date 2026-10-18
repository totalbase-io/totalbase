// Shared trigger catalog for WorkflowTriggerFields.vue (and the two
// wizards that embed it) - a plain module, not <script setup>, because
// Vue SFCs can't have named ES module exports (Vite compiler error).
// Titles and descriptions are translated keys (workflows.triggers.*),
// resolved in the current language by the composables below.
export interface TriggerOption {
  value: 'MANUAL' | 'DATA_EVENT' | 'CRON' | 'WEBHOOK'
  icon: string
  title: string
  description: string
}

const TRIGGER_KEYS: Record<TriggerOption['value'], string> = {
  MANUAL: 'manual',
  DATA_EVENT: 'dataEvent',
  CRON: 'cron',
  WEBHOOK: 'webhook'
}

export const TRIGGER_ICONS: Record<TriggerOption['value'], string> = {
  MANUAL: 'i-lucide-mouse-pointer-click',
  DATA_EVENT: 'i-lucide-database',
  CRON: 'i-lucide-clock',
  WEBHOOK: 'i-lucide-webhook'
}

/** The trigger cards, in the UI's language. */
export function useTriggerOptions() {
  const { t } = useI18n()
  return computed<TriggerOption[]>(() => (Object.keys(TRIGGER_KEYS) as TriggerOption['value'][]).map(value => ({
    value,
    icon: TRIGGER_ICONS[value],
    title: t(`workflows.triggers.${TRIGGER_KEYS[value]}.title`),
    description: t(`workflows.triggers.${TRIGGER_KEYS[value]}.description`)
  })))
}

/** Each trigger's configuration step (title and description), in the UI's language. */
export function useTriggerConfigMeta() {
  const { t } = useI18n()
  return computed(() => Object.fromEntries((Object.keys(TRIGGER_KEYS) as TriggerOption['value'][]).map(value => [value, {
    title: t(`workflows.triggers.${TRIGGER_KEYS[value]}.title`),
    description: t(`workflows.triggers.${TRIGGER_KEYS[value]}.configDescription`)
  }])) as Record<TriggerOption['value'], { title: string, description: string }>)
}
