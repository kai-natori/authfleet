// Production entry for the Cloudflare Workers deployment (Worker
// `authfleet-web`). `vite build` emits a fetch handler at
// dist/server/server.js plus static assets under dist/client.
//
// Two jobs beyond plain SSR:
// 1. Expose the Worker env (which carries the API service binding) to
//    the server code via a global. Bindings are identical for every
//    request in an isolate, so this hand-off is race-safe in practice.
//    Server code must treat it as read-only.
// 2. Apply a minimal security-header policy to every response.
import serverEntry from "./dist/server/server.js";

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env, ctx) {
    globalThis.__AUTHFLEET_ENV__ = env;
    const assetResponse = await env.ASSETS.fetch(request);
    const response =
      assetResponse.status === 404 ? await serverEntry.fetch(request, env, ctx) : assetResponse;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
