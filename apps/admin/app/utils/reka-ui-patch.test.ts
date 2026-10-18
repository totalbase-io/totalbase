import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// patches/reka-ui@*.patch: Reka's ComboboxTrigger hard-codes aria-label="Show popup", which outranks
// the UFormField's <label for> - every USelectMenu was announced as "Show popup" instead of its
// field's label. The patch drops it; this fails if a reka-ui upgrade ships without it.
describe('reka-ui patch', () => {
  it('leaves a select menu\'s trigger named by its field\'s label', () => {
    // The reka-ui that @nuxt/ui itself resolves (pnpm: its sibling in the store).
    const nuxtUi = realpathSync(fileURLToPath(new URL('../../node_modules/@nuxt/ui', import.meta.url)))
    const rekaDist = dirname(createRequire(join(nuxtUi, 'package.json')).resolve('reka-ui'))
    for (const file of ['ComboboxTrigger.js', 'ComboboxTrigger.cjs']) {
      expect(readFileSync(join(rekaDist, 'Combobox', file), 'utf8')).not.toContain('Show popup')
    }
  })
})
