import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Matrix wiring: pnpm LINKS workspace packages, so the plugin's own
 * node_modules (its better-auth 1.7 devDependency) would win module
 * resolution and the plugin would silently bind to 1.7 even inside
 * this 1.4 app. These aliases force every `better-auth` import in the
 * whole module graph — including the plugin source's — to THIS
 * package's better-auth 1.4.22, and `authfleet` to the plugin source
 * (not its prebuilt dist). That is what makes this cell a real 1.4
 * test rather than theatre.
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
      { find: /^better-auth$/, replacement: ba("dist/index.mjs") },
      { find: /^better-auth\/api$/, replacement: ba("dist/api/index.mjs") },
      { find: /^better-auth\/db$/, replacement: ba("dist/db/index.mjs") },
      { find: /^better-auth\/plugins$/, replacement: ba("dist/plugins/index.mjs") },
    ],
  },
  test: { include: ["test/**/*.test.ts"] },
});
