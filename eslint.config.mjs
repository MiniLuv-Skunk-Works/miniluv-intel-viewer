import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".build/**", "dist/**", "node_modules/**", "output/**", "package-lock.json"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "off",
    },
  },
  {
    files: ["*.ts", "src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/main.ts", "src/preload.ts", "src/window-manager.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["src/renderer/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.mjs", "eslint.config.mjs"],
    languageOptions: { globals: globals.node },
  },
);
