import type { ProjectStatsSummary, PublicProject } from "@authfleet/core";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";

/**
 * Server-side client for the AuthFleet api Worker.
 *
 * Production: calls go through the API *service binding* (wrangler
 * `services` in apps/web/wrangler.jsonc). The api Worker has no public
 * URL (workers_dev=false, no routes), so this binding is the only path.
 * Local dev: falls back to HTTP at AUTHFLEET_API_URL
 * (default http://127.0.0.1:8788, `wrangler dev` for apps/api).
 *
 * Every call forwards the operator identity: the
 * `Cf-Access-Authenticated-User-Email` header Cloudflare Access injected
 * in front of this web app. Without Access (local dev), the documented
 * dev bypass identity is used when AUTHFLEET_DEV_BYPASS=1.
 */

interface ApiBinding {
  fetch: (request: Request) => Promise<Response>;
}

export interface ProjectsResponse {
  projects: PublicProject[];
  operator: string;
}

export interface ProjectStatsResponse {
  project: PublicProject;
  summary: ProjectStatsSummary;
}

function getApiBinding(): ApiBinding | null {
  const env = globalThis.__AUTHFLEET_ENV__ as Record<string, unknown> | undefined;
  const binding = env?.API as ApiBinding | undefined;
  return binding && typeof binding.fetch === "function" ? binding : null;
}

async function operatorEmail(): Promise<string | undefined> {
  try {
    // Dynamic import: this module is server-only (see callApi below) and
    // must never be pulled into the client bundle.
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const fromAccess = request?.headers.get("cf-access-authenticated-user-email");
    if (fromAccess) return fromAccess;
  } catch {
    // Not in a request context (should not happen for server functions).
  }
  if (process.env.AUTHFLEET_DEV_BYPASS === "1") {
    return process.env.AUTHFLEET_DEV_OPERATOR ?? "dev@local";
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
      | (T & { error?: string })
      | { error?: string }
      | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `AuthFleet api error: HTTP ${response.status}`);
    }
    return body as T;
  },
);

export const listProjectsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectsResponse> => callApi<ProjectsResponse>("/api/projects"),
);

export const getProjectStatsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(
    async ({ data }): Promise<ProjectStatsResponse> =>
      callApi<ProjectStatsResponse>(`/api/projects/${encodeURIComponent(data)}/stats`),
  );

export interface CreateProjectInput {
  name: string;
  cfAccountId: string;
  d1DatabaseId: string;
  token: string;
}

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
