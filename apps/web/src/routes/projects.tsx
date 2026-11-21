import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import {
  type AgentHealth,
  AgentProjectFields,
  D1ProjectFields,
  ProjectList,
} from "~/components/project-fields";
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
import { Separator } from "~/components/ui/separator";
import {
  type CreateProjectInput,
  createProjectFn,
  deleteProjectFn,
  generateAgentKeyFn,
  getProjectStatsFn,
  listProjectsFn,
} from "~/server/api";

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

      <ProjectList projects={projects} agentStatus={agentStatus} busy={busy} onDelete={onDelete} />

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
          <form className="grid gap-5" onSubmit={(e) => void onCreate(e)}>
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

            <Separator />

            {projectType === "d1" ? (
              <D1ProjectFields />
            ) : (
              <AgentProjectFields
                apiKeyValue={apiKeyValue}
                setApiKeyValue={setApiKeyValue}
                generated={generated}
                busy={busy}
                onGenerateKey={onGenerateKey}
              />
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
