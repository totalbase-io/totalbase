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
    { name: 'parallel', testIgnore: [/[\\/]v1[\\/]/, /ui-dataviews\.spec\.ts$/] },
    // Every v1 file recreates the same e2e_v1_* tables in its beforeAll (v1/fixtures.ts resetSchema): one at a time.
    { name: 'v1', testMatch: /[\\/]v1[\\/].*\.spec\.ts$/, workers: 1 },
    // Its App menu tests rearrange the instance's one menu, which every other file's DataViews join and leave as
    // they're published and deleted: a save naming one just deleted is refused (409). Run alone, after the rest
    // (scripts/test-e2e.sh).
    { name: 'dataviews', testMatch: /ui-dataviews\.spec\.ts$/ }
  ]
})
