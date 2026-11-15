import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { createProjectFn, deleteProjectFn, listProjectsFn } from "~/server/api";

export const Route = createFileRoute("/projects")({
  loader: async () => listProjectsFn(),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { projects } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await createProjectFn({
        data: {
          name: String(form.get("name") ?? ""),
          cfAccountId: String(form.get("cfAccountId") ?? ""),
          d1DatabaseId: String(form.get("d1DatabaseId") ?? ""),
          token: String(form.get("token") ?? ""),
        },
      });
      await router.invalidate();
      event.currentTarget.reset();
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
          Each project needs a Cloudflare API token with read-only D1 access to its database. The
          token is encrypted before it is stored and is never shown again.
        </p>
      </div>

      <div className="grid gap-4">
        {projects.map((project) => (
          <Card key={project.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {project.name}
                  {project.isDemo ? <Badge variant="secondary">demo</Badge> : null}
                </CardTitle>
                <CardDescription>
                  Account {project.cfAccountId} · D1 {project.d1DatabaseId} · token ……
                  {project.tokenHint}
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
        ))}
        {projects.length === 0 ? (
          <p className="text-muted-foreground">No projects registered.</p>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a project</CardTitle>
          <CardDescription>
            Create a Cloudflare API token scoped to D1 read for the target database first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(e) => void onCreate(e)}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="my-app" />
            </div>
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
