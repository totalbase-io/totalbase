import { defineConfig } from "vitest/config";

// One real PostgreSQL database shared by every test file - run them one at
// a time (see the repository root's vitest.config.ts).
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
