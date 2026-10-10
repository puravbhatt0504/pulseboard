import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/next-env.d.ts", "**/playwright-report/**", "**/test-results/**", "**/cdk.out/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Needed for `declare global { namespace Express }` request augmentation.
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    },
  },
);
