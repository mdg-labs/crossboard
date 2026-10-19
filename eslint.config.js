import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const processEnvImports = [
  {
    name: "node:process",
    importNames: ["env", "default"],
    message: "Read configuration through apps/server/src/config only.",
  },
  {
    name: "process",
    importNames: ["env", "default"],
    message: "Read configuration through apps/server/src/config only.",
  },
];

const octokitImportGroup = (...allowed) => ({
  group: ["octokit", "octokit/**", "@octokit/**", ...allowed],
  message:
    "Talk to GitHub through apps/server/src/github only (@octokit/webhooks is allowed in apps/server/src/webhooks).",
});

const processEnvSyntax = {
  selector:
    "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
  message: "Read configuration through apps/server/src/config only.",
};

// no-restricted-imports does not look at import("…").
const octokitDynamicImportSyntax = (allowWebhooks) => ({
  selector: `ImportExpression[source.value=/^(octokit|@octokit)/]${
    allowWebhooks ? ":not([source.value=/^@octokit.webhooks/])" : ""
  }`,
  message: "Talk to GitHub through apps/server/src/github only.",
});

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/coverage/",
    "**/test-results/",
    "**/playwright-report/",
    "**/.pnpm-store/",
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
        processEnvSyntax,
        octokitDynamicImportSyntax(false),
      ],
      "no-restricted-imports": [
        "error",
        { paths: processEnvImports, patterns: [octokitImportGroup()] },
      ],
    },
  },
  {
    files: ["apps/server/src/github/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", processEnvSyntax],
      "no-restricted-imports": ["error", { paths: processEnvImports }],
    },
  },
  {
    files: ["apps/server/src/webhooks/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        processEnvSyntax,
        octokitDynamicImportSyntax(true),
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: processEnvImports,
          patterns: [
            octokitImportGroup("!@octokit/webhooks", "!@octokit/webhooks/**"),
          ],
        },
      ],
    },
  },
);
