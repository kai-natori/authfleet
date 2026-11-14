import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Vitest uses this config instead of vite.config.ts: unit tests must not
// load the TanStack Start / Tailwind build plugins.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
