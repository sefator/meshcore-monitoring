import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json"
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }]
    }
  }
);
