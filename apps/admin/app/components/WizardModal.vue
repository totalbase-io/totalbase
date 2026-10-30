<script setup lang="ts">
/**
 * The product's one multi-step creation flow (AGENTS.md section 25,
 * "Multi-step wizards"): a UModal whose body is a vertical UStepper rail
 * beside the current step, and a footer with Back / Cancel on one side and
 * Next or the final action on the other. It owns navigation only - the
 * current step, how far the user got (a reached step can be reopened from
 * the rail, a later one can't), Next held until the step is `valid`. Each
 * wizard keeps its own form state and validity and fills the steps
 * through slots.
 *
 * A step's slot (`#<key>`) mounts the first time the step is reached and
 * then stays mounted (v-show), so going back and forth never drops what
 * was typed. The default slot (`{ current }`) is for content that spans
 * several steps - it is always mounted and shows itself as it needs.
 *
 * On a phone or a tablet, or any screen below `md` (`useCompactUi`), the
 * modal is fullscreen and the rail becomes one line: "Step 2 of 6", the
 * step's title and description, a progress bar. Back/Next still move
 * between steps; a fixed `height` doesn't apply (the modal body scrolls).
 * A desktop window from `md` up keeps the rail beside the step.
 */
import type { StepperItem } from '@nuxt/ui'

export interface WizardStep {
  key: string
  title: string
  description?: string
  /** Next (or the final action) stays disabled while this is false. */
  valid?: boolean
}

const props = withDefaults(defineProps<{
  title: string
  description?: string
  steps: WizardStep[]
  submitLabel?: string
  submitting?: boolean
  /** The modal's width (a UModal `content` class). */
  width?: string
  /** A fixed body height (e.g. `h-[52vh]`): the rail stays put and only the step scrolls - for a long step. */
  height?: string
  /** Every step reachable from the start - editing something already complete, not building it step by step. */
  allReachable?: boolean
  /** Runs before leaving a step with Next; return false to stay (after telling the user why). */
  beforeNext?: (key: string) => boolean
}>(), { description: undefined, submitLabel: undefined, submitting: false, width: 'max-w-3xl', height: undefined, allReachable: false, beforeNext: undefined })
const emit = defineEmits<{ submit: [] }>()

const open = defineModel<boolean>('open', { default: false })
/** Index of the current step - bind it only to read or force the position. */
const step = defineModel<number>('step', { default: 0 })

/** A phone, a tablet, or a screen below `md` - the one-line stepper, fullscreen. */
const isMobile = useCompactUi()
const { t } = useI18n()
/** The fixed body height - desktop only, a compact wizard scrolls the whole modal body. */
const fixedHeight = computed(() => (isMobile.value ? undefined : props.height))

const maxVisited = ref(0)
const visited = ref(new Set<string>())
const current = computed(() => props.steps[step.value])
const isLast = computed(() => step.value === props.steps.length - 1)
const canContinue = computed(() => current.value?.valid !== false)

watch(open, (value) => {
  if (!value) return
  step.value = 0
  maxVisited.value = props.allReachable ? Math.max(0, props.steps.length - 1) : 0
  visited.value = new Set(props.steps[0] ? [props.steps[0].key] : [])
})
watch(() => current.value?.key, (key) => {
  if (key) visited.value.add(key)
}, { immediate: true })
// A conditional step dropping out shortens the list - keep both indexes in range.
watch(() => props.steps.length, (length) => {
  const last = Math.max(0, length - 1)
  if (step.value > last) step.value = last
  if (maxVisited.value > last) maxVisited.value = last
})

const items = computed<StepperItem[]>(() => props.steps.map((s, i) => ({
  value: s.key,
  title: s.title,
  description: s.description,
  icon: i < step.value ? 'i-lucide-check' : undefined,
  disabled: i > maxVisited.value
})))
const stepperValue = computed<string | number | undefined>({
  get: () => current.value?.key,
  set: (key) => {
    const index = props.steps.findIndex(s => s.key === key)
    if (index >= 0 && index <= maxVisited.value) step.value = index
  }
})

function next() {
  if (!canContinue.value || isLast.value) return
  if (props.beforeNext && current.value && !props.beforeNext(current.value.key)) return
  step.value += 1
  maxVisited.value = Math.max(maxVisited.value, step.value)
}
function back() {
  if (step.value > 0) step.value -= 1
}
defineExpose({ next, back })
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :fullscreen="isMobile"
    :ui="isMobile ? undefined : fixedHeight ? { content: width, body: 'overflow-hidden' } : { content: width }"
  >
    <template #body>
      <div
        class="grid grid-cols-1 gap-6"
        :class="[isMobile ? undefined : 'md:grid-cols-[200px_minmax(0,1fr)]', fixedHeight ? [fixedHeight, 'overflow-hidden'] : undefined]"
      >
        <div
          v-if="isMobile"
          class="flex flex-col gap-1"
        >
          <p class="text-xs text-muted">
            {{ t('shell.wizard.stepOf', { step: step + 1, total: steps.length }) }}
          </p>
          <p class="text-sm font-medium text-highlighted">
            {{ current?.title }}
          </p>
          <p
            v-if="current?.description"
            class="text-xs text-muted"
          >
            {{ current.description }}
          </p>
          <UProgress
            :model-value="step + 1"
            :max="steps.length"
            size="xs"
            class="mt-1.5"
          />
        </div>
        <!-- UStepper (Nuxt UI 4.11) hands Reka a 0-based step while Reka
        counts from 1, so its live region announces one step behind: hide it
        and announce the step ourselves. -->
        <p
          v-if="!isMobile"
          class="sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {{ t('shell.wizard.stepOf', { step: step + 1, total: steps.length }) }}: {{ current?.title }}
        </p>
        <UStepper
          v-if="!isMobile"
          v-model="stepperValue"
          :items="items"
          orientation="vertical"
          size="sm"
          :linear="false"
          class="[&_[role=status]]:hidden"
        >
          <!-- UStepper only makes the indicator clickable; the title and
          description open the step too, as the whole rail entry should. -->
          <template #title="{ item }">
            <button
              type="button"
              class="cursor-pointer text-start disabled:cursor-not-allowed"
              :disabled="item.disabled"
              @click="stepperValue = item.value"
            >
              {{ item.title }}
            </button>
          </template>
          <template #description="{ item }">
            <button
              type="button"
              tabindex="-1"
              class="cursor-pointer text-start disabled:cursor-not-allowed"
              :disabled="item.disabled"
              @click="stepperValue = item.value"
            >
              {{ item.description }}
            </button>
          </template>
        </UStepper>
        <!-- min-w-0: a wide step (a table) scrolls inside itself, never widens the modal's content past it. -->
        <div
          class="flex min-w-0 flex-col gap-4"
          :class="fixedHeight ? 'min-h-0 overflow-y-auto pr-2' : 'min-h-72'"
        >
          <template
            v-for="s in steps"
            :key="s.key"
          >
            <div
              v-if="visited.has(s.key)"
              v-show="current?.key === s.key"
            >
              <slot :name="s.key" />
            </div>
          </template>
          <slot :current="current?.key" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-between gap-2">
        <UButton
          v-if="step > 0"
          color="neutral"
          variant="ghost"
          :label="t('common.back')"
          :disabled="submitting"
          @click="back"
        />
        <div
          v-else
          class="flex-1"
        />
        <div class="flex gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            :disabled="submitting"
            @click="open = false"
          />
          <UButton
            v-if="!isLast"
            :label="t('common.next')"
            :disabled="!canContinue"
            @click="next"
          />
          <UButton
            v-else
            :label="submitLabel ?? t('common.create')"
            :loading="submitting"
            :disabled="!canContinue"
            @click="emit('submit')"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
