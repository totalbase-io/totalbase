import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Plain unit tests for app/utils (pure functions) - no Nuxt runtime. `~`
// mirrors Nuxt's own alias so those modules can import each other (and
// app/types) the same way the app does.
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) }
  },
  test: {
    include: ['app/**/*.test.ts']
  }
})
