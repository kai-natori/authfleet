import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { type PluginStatus, pluginStatusInfo } from "~/lib/plugin-status";
import {
  type CreateProjectInput,
  createProjectFn,
  deleteProjectFn,
  generateAgentKeyFn,
  getProjectStatsFn,
  listProjectsFn,
} from "~/server/api";

type AgentHealth = PluginStatus | "healthy";

export const Route = createFileRoute("/projects")({
  loader: async () => {
    const { projects } = await listProjectsFn();
    // Plugin status for agent projects is first-class on the list:
    // probe each one's stats endpoint and keep the resulting state.
    const agentStatus: Record<string, AgentHealth> = {};
    await Promise.all(
      projects
        .filter((p) => p.type === "agent")
        .map(async (p) => {
          const result = await getProjectStatsFn({ data: p.id });
          agentStatus[p.id] = result.ok ? "healthy" : (result.pluginStatus ?? "upstream");
        }),
    );
    return { projects, agentStatus };
  },
  component: ProjectsPage,
});

const PLUGIN_SNIPPET = `// your Better Auth config
import { authfleet } from "authfleet";

export const auth = betterAuth({
  plugins: [
    authfleet({
      apiKeyHash: process.env.AUTHFLEET_API_KEY_HASH,
    }),
  ],
});`;

function ProjectsPage() {
  const { projects, agentStatus } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectType, setProjectType] = useState<"d1" | "agent">("d1");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [generated, setGenerated] = useState<{ apiKey: string; apiKeyHash: string } | null>(null);

  async function onGenerateKey() {
    setBusy(true);
    setError(null);
    try {
      const key = await generateAgentKeyFn();
      setGenerated(key);
      setApiKeyValue(key.apiKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to generate a key");
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const input: CreateProjectInput =
      projectType === "agent"
        ? {
            type: "agent",
            name,
            baseUrl: String(form.get("baseUrl") ?? ""),
            apiKey: apiKeyValue,
          }
        : {
            type: "d1",
            name,
            cfAccountId: String(form.get("cfAccountId") ?? ""),
            d1DatabaseId: String(form.get("d1DatabaseId") ?? ""),
            token: String(form.get("token") ?? ""),
          };
    try {
      await createProjectFn({ data: input });
      await router.invalidate();
      event.currentTarget.reset();
      setApiKeyValue("");
      setGenerated(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add project");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteProjectFn({ data: id });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to delete project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Two connection types: <strong>D1</strong> projects are read directly through the
          Cloudflare API; <strong>Plugin</strong> projects run the AuthFleet plugin inside the app,
          on any database. Credentials are encrypted before they are stored and never shown again.
        </p>
      </div>

      <div className="grid gap-4">
        {projects.map((project) => {
          const health = project.type === "agent" ? agentStatus[project.id] : undefined;
          return (
            <Card key={project.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {project.name}
                    <Badge variant="outline">{project.type === "agent" ? "Plugin" : "D1"}</Badge>
                    {project.isDemo ? <Badge variant="secondary">demo</Badge> : null}
                    {health === "healthy" ? <Badge variant="secondary">Plugin OK</Badge> : null}
                    {health && health !== "healthy" ? (
                      <Badge variant="destructive">{pluginStatusInfo(health).label}</Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription>
                    {project.type === "d1" ? (
                      <>
                        Account {project.cfAccountId} · D1 {project.d1DatabaseId} · token ……
                        {project.tokenHint}
                      </>
                    ) : (
                      <>
                        {project.baseUrl} · API key …{project.tokenHint}
                        {health && health !== "healthy" ? (
                          <> — {pluginStatusInfo(health).description}</>
                        ) : null}
                      </>
                    )}
                  </CardDescription>
                </div>
                {!project.isDemo ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onDelete(project.id)}
                  >
                    Delete
                  </Button>
                ) : null}
              </CardHeader>
            </Card>
          );
        })}
        {projects.length === 0 ? (
          <p className="text-muted-foreground">No projects registered.</p>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a project</CardTitle>
          <CardDescription>
            {projectType === "d1"
              ? "Create a Cloudflare API token scoped to D1 read for the target database first."
              : "Install the plugin in the target app first (below). Registration checks the plugin connection before saving."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(e) => void onCreate(e)}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="my-app" />
            </div>
            <div className="grid gap-2">
              <Label>Connection type</Label>
              <Select
                value={projectType}
                onValueChange={(value) => {
                  if (value === "d1" || value === "agent") setProjectType(value);
                }}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="d1">D1 — read via Cloudflare API</SelectItem>
                  <SelectItem value="agent">Plugin — in-app agent (any database)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {projectType === "d1" ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="cfAccountId">Cloudflare account ID</Label>
                  <Input id="cfAccountId" name="cfAccountId" required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="d1DatabaseId">D1 database ID</Label>
                  <Input id="d1DatabaseId" name="d1DatabaseId" required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="token">Cloudflare API token (read-only D1)</Label>
                  <Input id="token" name="token" type="password" required autoComplete="off" />
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="baseUrl">Better Auth base URL</Label>
                  <Input
                    id="baseUrl"
                    name="baseUrl"
                    required
                    placeholder="https://example.com/api/auth"
                  />
                  <p className="text-xs text-muted-foreground">
                    The app's origin + Better Auth base path. HTTPS required (http only for
                    localhost).
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="apiKey">Plugin API key</Label>
                  <div className="flex gap-2">
                    <Input
                      id="apiKey"
                      name="apiKey"
                      type="password"
                      required
                      autoComplete="off"
                      value={apiKeyValue}
                      onChange={(e) => setApiKeyValue(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void onGenerateKey()}
                    >
                      Generate a key
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Generate one here, or paste a key you created yourself (at least 32 characters).
                    The app only ever receives the key's SHA-256 hash — never the key.
                  </p>
                </div>
                {generated ? (
                  <div className="grid gap-2 rounded-md border p-3 text-sm">
                    <p className="font-medium">
                      Your generated key (already filled in above — shown only in this form):
                    </p>
                    <code className="break-all">{generated.apiKey}</code>
                    <p>
                      Put its hash in the target app's environment. This hash is what the plugin
                      checks against:
                    </p>
                    <code className="break-all">AUTHFLEET_API_KEY_HASH={generated.apiKeyHash}</code>
                  </div>
                ) : null}
                <div className="grid gap-2 rounded-md border p-3 text-sm">
                  <p className="font-medium">Install the plugin in the target app:</p>
                  <code>npm install authfleet</code>
                  <pre className="overflow-x-auto whitespace-pre-wrap">{PLUGIN_SNIPPET}</pre>
                  <p className="text-muted-foreground">
                    Using your own key instead? Its hash is:{" "}
                    <code>printf %s "YOUR_KEY" | shasum -a 256</code>
                  </p>
                </div>
              </>
            )}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              Add project
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
