import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  {
    ignores: [".jules/**", "node_modules/**", "dist/**"],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.node,
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "warn",
    },
  },
];
