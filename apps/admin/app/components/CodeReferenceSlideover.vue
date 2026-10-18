<script setup lang="ts">
/**
 * The Code tab's Reference: what a handler's `dataview` holds
 * (utils/custom-code-reference.ts). A sidebar - looked up beside the code,
 * not worked in (AGENTS.md section 25); Insert puts an entry's example at the
 * editor's cursor.
 */
import { CODE_REFERENCE, CODE_REFERENCE_KEY } from '~/utils/custom-code-reference'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ insert: [example: string] }>()
const { t } = useI18n()
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('designer.codeReferenceSlideover.title')"
    :description="t('designer.codeReferenceSlideover.description')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <section
          v-for="section in CODE_REFERENCE"
          :key="section.key"
          class="flex flex-col gap-3"
        >
          <div>
            <h3 class="text-sm font-semibold text-highlighted">
              {{ t(`${CODE_REFERENCE_KEY}.${section.key}.title`, section.titleParams ?? {}) }}
            </h3>
            <p
              v-if="section.described"
              class="text-xs text-muted"
            >
              {{ t(`${CODE_REFERENCE_KEY}.${section.key}.description`) }}
            </p>
          </div>
          <div
            v-for="entry in section.entries"
            :key="entry.signature"
            class="flex flex-col gap-1 border-l border-default pl-3"
          >
            <code class="font-mono text-xs text-highlighted">{{ entry.signature }}</code>
            <p class="text-xs text-muted">
              {{ t(`${CODE_REFERENCE_KEY}.${section.key}.entries.${entry.key}`, entry.params ?? {}) }}
            </p>
            <div
              v-if="entry.example"
              class="flex items-center gap-2"
            >
              <code class="min-w-0 flex-1 truncate rounded bg-elevated px-2 py-1 font-mono text-xs">{{ entry.example }}</code>
              <UButton
                :label="t('designer.codeReferenceSlideover.insert')"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="emit('insert', entry.example)"
              />
            </div>
          </div>
        </section>
      </div>
    </template>
  </USlideover>
</template>
