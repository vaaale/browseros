import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // External spec stores (018-external-spec-store) are independent git repos
    // mounted under specs/ at runtime — not BrowserOS source, and absent (and
    // gitignored) in a plain checkout, so the app's eslint must not lint them.
    "specs/**",
    // bastion/ is a standalone Node.js/Express + react-router sub-project with
    // its own package.json/tsconfig — not part of the Next.js app, so the
    // app's Next/React lint rules do not apply to it.
    "bastion/**",
  ]),
]);

export default eslintConfig;
