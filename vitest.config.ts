import { configDefaults, defineConfig } from "vitest/config";

// Integration tests share one real PostgreSQL database (AGENTS.md section
// 23), and some of what they exercise is global by design - a catalog
// reconcile marks MISSING (and purges) any resource whose OID isn't a real
// object, settings are instance-wide - so files run one at a time, the
// same call packages/audit made for its own. e2e/ holds Playwright specs
// (their own runner); apps/admin is a Nuxt app whose unit tests need the
// `~` alias - run them from its own package.
export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "e2e/**", "apps/admin/**"],
  },
});
