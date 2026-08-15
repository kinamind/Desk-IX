import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".wrangler/**", "dist/**", "coverage/**", "worker-configuration.d.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ["**/*.ts"] })),
  {
    files: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly" } },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
);
