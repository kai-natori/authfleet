import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Wiring: pnpm LINKS workspace packages, so without aliases the
 * imports would land on the packages' prebuilt dist (or fail before a
 * first build). These aliases bind `authfleet` to the plugin SOURCE
 * and `@authfleet/core` to the core SOURCE, and every `better-auth`
 * import in the whole module graph — including the plugin source's —
 * to THIS package's better-auth 1.7.25. That keeps `pnpm test`
 * self-contained (no prior build) and makes the e2e exercise the
 * exact sources the other suites test.
 */
const ba = (sub: string) =>
  fileURLToPath(new URL(`./node_modules/better-auth/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^authfleet$/,
        replacement: fileURLToPath(new URL("../plugin/src/index.ts", import.meta.url)),
      },
      {
        find: /^@authfleet\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
      { find: /^better-auth$/, replacement: ba("dist/index.mjs") },
      { find: /^better-auth\/api$/, replacement: ba("dist/api/index.mjs") },
      { find: /^better-auth\/db$/, replacement: ba("dist/db/index.mjs") },
      { find: /^better-auth\/plugins$/, replacement: ba("dist/plugins/index.mjs") },
    ],
  },
  test: { include: ["test/**/*.test.ts"] },
});
