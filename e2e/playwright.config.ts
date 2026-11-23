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
    { name: 'parallel', testIgnore: [/[\\/]v1[\\/]/, /ui-dataviews\.spec\.ts$/, /ui-lockdown\.spec\.ts$/, /graphql(-docs)?\.spec\.ts$/, /[\\/]security[\\/]/] },
    // Its subscription needs Realtime on, which realtime.spec.ts turns off when it ends: after the parallel files.
    { name: 'graphql', testMatch: /graphql\.spec\.ts$/, dependencies: ['parallel'] },
    // The docs' GraphQL examples, run as written: GraphQL and Realtime on too, which graphql.spec.ts turns off when it
    // ends - after it.
    { name: 'graphql-docs', testMatch: /graphql-docs\.spec\.ts$/, dependencies: ['graphql'] },
    // Every v1 file recreates the same e2e_v1_* tables in its beforeAll (v1/fixtures.ts resetSchema): one at a time.
    { name: 'v1', testMatch: /[\\/]v1[\\/].*\.spec\.ts$/, workers: 1 },
    // Its App menu tests rearrange the instance's one menu, which every other file's DataViews join and leave as
    // they're published and deleted: a save naming one just deleted is refused (409). Run alone, after the rest
    // (scripts/test-e2e.sh).
    { name: 'dataviews', testMatch: /ui-dataviews\.spec\.ts$/ },
    // The security suite (tests/security, Foundations.md §21.3): attacks as an agent would, each file on its own copy of
    // a small app - some turn instance settings on and back off (MCP, the SQL Console for tokens), so one at a time, in
    // a pass of its own before lockdown (scripts/test-e2e.sh).
    { name: 'security', testMatch: /[\\/]security[\\/].*\.spec\.ts$/, workers: 1 },
    // A lockdown closes the instance to every other file's users and tokens (Security.md §2.21). Run alone, last
    // (scripts/test-e2e.sh).
    { name: 'lockdown', testMatch: /ui-lockdown\.spec\.ts$/, workers: 1 }
  ]
})
