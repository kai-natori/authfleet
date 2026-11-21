import { generateRandomToken, type ProjectStatsSummary, type PublicProject } from "@authfleet/core";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { isPluginStatus, type PluginStatus } from "../lib/plugin-status";

/**
 * Server-side client for the AuthFleet api Worker.
 *
 * Production: calls go through the API *service binding* (wrangler
 * `services` in apps/web/wrangler.jsonc). The api Worker has no public
 * URL (workers_dev=false, no routes), so this binding is the only path.
 * Local dev: falls back to HTTP at AUTHFLEET_API_URL
 * (default http://127.0.0.1:8788, `wrangler dev` for apps/api).
 *
 * Every call forwards the operator identity as `x-authfleet-operator`.
 * The identity comes from the VERIFIED Cloudflare Access JWT
 * (`Cf-Access-Jwt-Assertion`, checked against the team JWKS and the
 * configured AUD — see ./access.ts), never from the plain
 * `Cf-Access-Authenticated-User-Email` header, which is spoofable on
 * any path that reaches this Worker without traversing Access
 * (audit F1). Access verification is configured with
 * AUTHFLEET_ACCESS_TEAM_DOMAIN + AUTHFLEET_ACCESS_AUD; when Access is
 * configured the JWT is mandatory and invalid/missing assertions throw
 * (fail closed). Without Access config (local dev only), the documented
 * dev bypass identity is used when AUTHFLEET_DEV_BYPASS=1; otherwise no
 * identity is sent and the api answers 401.
 */

import { verifyAccessJwt } from "./access";

interface ApiBinding {
  fetch: (request: Request) => Promise<Response>;
}

export interface ProjectsResponse {
  projects: PublicProject[];
}

export interface ProjectStatsResponse {
  project: PublicProject;
  summary: ProjectStatsSummary;
}

/** The Worker env object published per-request by worker.mjs. */
function workerEnv(): Record<string, unknown> | undefined {
  return globalThis.__AUTHFLEET_ENV__ as Record<string, unknown> | undefined;
}

function getApiBinding(): ApiBinding | null {
  const binding = workerEnv()?.API as ApiBinding | undefined;
  return binding && typeof binding.fetch === "function" ? binding : null;
}

/** Read a config value from the Worker env (bindings/vars) or process env. */
function serverEnv(name: string): string | undefined {
  const fromWorker = workerEnv()?.[name];
  if (typeof fromWorker === "string" && fromWorker.length > 0) return fromWorker;
  const fromProcess = process.env[name];
  return fromProcess && fromProcess.length > 0 ? fromProcess : undefined;
}

async function operatorEmail(): Promise<string | undefined> {
  const teamDomain = serverEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN");
  const audience = serverEnv("AUTHFLEET_ACCESS_AUD");
  if (teamDomain || audience) {
    if (!teamDomain || !audience) {
      throw new Error(
        "Cloudflare Access is partially configured: set both AUTHFLEET_ACCESS_TEAM_DOMAIN and AUTHFLEET_ACCESS_AUD",
      );
    }
    // Dynamic import: this module is server-only (see callApi below) and
    // must never be pulled into the client bundle.
    const { getRequest } = await import("@tanstack/react-start/server");
    const assertion = getRequest()?.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      throw new Error("Cloudflare Access JWT (Cf-Access-Jwt-Assertion) is missing");
    }
    const claims = await verifyAccessJwt(assertion, { teamDomain, audience });
    return claims.email;
  }
  // No Access configured: local development only. The dev bypass is
  // strictly env-gated and never active when Access is configured.
  if (serverEnv("AUTHFLEET_DEV_BYPASS") === "1") {
    return serverEnv("AUTHFLEET_DEV_OPERATOR") ?? "dev@local";
  }
  return undefined;
}

export const callApi = createServerOnlyFn(
  async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    const operator = await operatorEmail();
    if (operator) headers.set("x-authfleet-operator", operator);

    const binding = getApiBinding();
    let response: Response;
    if (binding) {
      response = await binding.fetch(
        new Request(`https://authfleet-api.internal${path}`, { ...init, headers }),
      );
    } else {
      const base = process.env.AUTHFLEET_API_URL ?? "http://127.0.0.1:8788";
      response = await fetch(`${base}${path}`, { ...init, headers });
    }
    const body = (await response.json().catch(() => null)) as
      | (T & { error?: string; pluginStatus?: unknown })
      | { error?: string; pluginStatus?: unknown }
      | null;
    if (!response.ok) {
      const error = new Error(body?.error ?? `AuthFleet api error: HTTP ${response.status}`);
      // Agent-project stats failures carry the plugin status kind so
      // callers can render first-class plugin states (see
      // ../lib/plugin-status). Anything unrecognized is dropped.
      if (isPluginStatus(body?.pluginStatus)) {
        (error as Error & { pluginStatus?: PluginStatus }).pluginStatus = body.pluginStatus;
      }
      throw error;
    }
    return body as T;
  },
);

export const listProjectsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectsResponse> => callApi<ProjectsResponse>("/api/projects"),
);

/**
 * The operator identity for display, resolved (and, with Access
 * configured, cryptographically verified) on the web side. The api no
 * longer echoes the identity back (audit F8).
 */
export const getOperatorFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ operator: string | null }> => ({
    operator: (await operatorEmail()) ?? null,
  }),
);

/**
 * Stats as a result union: agent-plugin failure states are data, not
 * exceptions, so the dashboard can render them distinctly (and never
 * as a zero-user project). Non-plugin failures keep a null status.
 */
export type ProjectStatsResult =
  | { ok: true; data: ProjectStatsResponse }
  | { ok: false; pluginStatus: PluginStatus | null; error: string };

export const getProjectStatsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data }): Promise<ProjectStatsResult> => {
    try {
      const response = await callApi<ProjectStatsResponse>(
        `/api/projects/${encodeURIComponent(data)}/stats`,
      );
      return { ok: true, data: response };
    } catch (cause) {
      const pluginStatus = (cause as { pluginStatus?: unknown })?.pluginStatus;
      return {
        ok: false,
        pluginStatus: isPluginStatus(pluginStatus) ? pluginStatus : null,
        error: cause instanceof Error ? cause.message : "failed to read project stats",
      };
    }
  });

export type CreateProjectInput =
  | {
      type: "d1";
      name: string;
      cfAccountId: string;
      d1DatabaseId: string;
      token: string;
    }
  | {
      type: "agent";
      name: string;
      baseUrl: string;
      apiKey: string;
    };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a fresh plugin API key for the registration form. The key
 * itself is shown ONCE in the form (and then stored encrypted by the
 * api at registration); the hash is what the operator pastes into the
 * target app's config as AUTHFLEET_API_KEY_HASH.
 */
export const generateAgentKeyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ apiKey: string; apiKeyHash: string }> => {
    if (!(await operatorEmail())) throw new Error("operator identity required");
    const apiKey = generateRandomToken(32);
    return { apiKey, apiKeyHash: await sha256Hex(apiKey) };
  },
);

export const createProjectFn = createServerFn({ method: "POST" })
  .validator((input: CreateProjectInput) => input)
  .handler(
    async ({ data }): Promise<{ project: PublicProject }> =>
      callApi("/api/projects", { method: "POST", body: JSON.stringify(data) }),
  );

export const deleteProjectFn = createServerFn({ method: "POST" })
  .validator((projectId: string) => projectId)
  .handler(
    async ({ data }): Promise<{ deleted: boolean }> =>
      callApi(`/api/projects/${encodeURIComponent(data)}`, { method: "DELETE" }),
  );

export const snapshotProjectFn = createServerFn({ method: "POST" })
  .validator((projectId: string) => projectId)
  .handler(
    async ({ data }): Promise<{ snapshot: { date: string; totalUsers: number } }> =>
      callApi(`/api/projects/${encodeURIComponent(data)}/snapshot`, { method: "POST" }),
  );
