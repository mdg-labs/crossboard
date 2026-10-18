import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/coverage/",
    ".claude/",
    ".agents/",
    "skills-lock.json",
    "pnpm-lock.yaml",
    "apps/web/src/components/ui/",
    "apps/server/src/db/migrations/",
  ]),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["apps/server/**/*.ts"],
    ignores: ["apps/server/src/config/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration through apps/server/src/config only.",
        },
        {
          object: "globalThis",
          property: "process",
          message: "Read configuration through apps/server/src/config only.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
          message: "Read configuration through apps/server/src/config only.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:process",
              importNames: ["env", "default"],
              message:
                "Read configuration through apps/server/src/config only.",
            },
            {
              name: "process",
              importNames: ["env", "default"],
              message:
                "Read configuration through apps/server/src/config only.",
            },
          ],
        },
      ],
    },
  },
);
