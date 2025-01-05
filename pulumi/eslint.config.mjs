import { sheriff } from "eslint-config-sheriff";
import { defineFlatConfig } from "eslint-define-config";

export default defineFlatConfig([
  ...sheriff(),
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-empty-interface": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-var-requires": "warn",
      "@typescript-eslint/naming-convention": "off",
      "arrow-return-style/arrow-return-style": "off",
      "no-promise-executor-return": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-shadow": "off",
      "unicorn/consistent-destructuring": "error",
      curly: "off",

      "func-style": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "warn",
        {
          allow: [{ name: ["Error", "URL", "URLSearchParams"], from: "lib" }],
          allowAny: true,
          allowBoolean: true,
          allowNullish: true,
          allowNumber: true,
          allowRegExp: true,
        },
      ],
    },
  },
]);
