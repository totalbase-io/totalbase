import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3030',
    headless: true
  },
  reporter: [['list']],
  projects: [
    { name: 'parallel', testIgnore: /[\\/]v1[\\/]/ },
    // Every v1 file recreates the same e2e_v1_* tables in its beforeAll (v1/fixtures.ts resetSchema): one at a time.
    { name: 'v1', testMatch: /[\\/]v1[\\/].*\.spec\.ts$/, workers: 1 }
  ]
})
