// Root ESLint (Pre_Beta_Review 5.7): the packages and the server have no linter of their own - this one is
// deliberately small, the type-aware rules that catch the mistakes a review keeps finding by hand (a promise
// left floating in a scheduler or a route). The admin keeps its own Nuxt ESLint config (apps/admin).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/admin/**", "e2e/**", "scripts/**", "**/*.mjs", "**/*.js"],
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/server/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, attributes: false } }],
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
