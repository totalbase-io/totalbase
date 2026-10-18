import { defineConfig } from "vitest/config";

// audit-service.test.ts toggles the shared totalbase.settings row
// "audit.enabled" off and back on; running test files in parallel let
// that race with audit-query-service.test.ts's beforeAll seeding real
// audit_logs rows through the same AuditService, causing intermittent
// "record() silently no-op'd because audit.enabled was false at that
// instant" failures. Both files hit the same real PostgreSQL database,
// so serializing them is the correct fix rather than mocking around it.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
