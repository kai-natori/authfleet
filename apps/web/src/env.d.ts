/// <reference types="vite/client" />

declare global {
  // Set by worker.mjs on every request (see that file). Bindings only.
  var __AUTHFLEET_ENV__: Record<string, unknown> | undefined;
}

export {};
