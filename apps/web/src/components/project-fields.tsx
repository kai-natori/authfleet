import type { PublicProject } from "@authfleet/core";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { type PluginStatus, pluginStatusInfo } from "~/lib/plugin-status";
import { cn } from "~/lib/utils";

export type AgentHealth = PluginStatus | "healthy";

const PLUGIN_SNIPPET = `// your Better Auth config
import { authfleet } from "authfleet";

export const auth = betterAuth({
  plugins: [
    authfleet({
      apiKeyHash: process.env.AUTHFLEET_API_KEY_HASH,
    }),
  ],
});`;

export function ProjectList({
  projects,
  agentStatus,
  busy,
  onDelete,
}: {
  projects: PublicProject[];
  agentStatus: Record<string, AgentHealth>;
  busy: boolean;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div className="grid gap-4">
      {projects.map((project) => {
        const health = project.type === "agent" ? agentStatus[project.id] : undefined;
        return (
          <Card key={project.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      project.type === "d1"
                        ? "bg-sky-500"
                        : health === "healthy"
                          ? "bg-emerald-500"
                          : "bg-destructive",
                    )}
                  />
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
  );
}

export function D1ProjectFields() {
  return (
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
  );
}

export function AgentProjectFields({
  apiKeyValue,
  setApiKeyValue,
  generated,
  busy,
  onGenerateKey,
}: {
  apiKeyValue: string;
  setApiKeyValue: (value: string) => void;
  generated: { apiKey: string; apiKeyHash: string } | null;
  busy: boolean;
  onGenerateKey: () => Promise<void>;
}) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="baseUrl">Better Auth base URL</Label>
        <Input id="baseUrl" name="baseUrl" required placeholder="https://example.com/api/auth" />
        <p className="text-xs text-muted-foreground">
          The app's origin + Better Auth base path. HTTPS required (http only for localhost).
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
          Generate one here, or paste a key you created yourself (at least 32 characters). The app
          only ever receives the key's SHA-256 hash — never the key.
        </p>
      </div>
      {generated ? (
        <div className="grid gap-2 rounded-lg border bg-muted/50 p-4 text-sm">
          <p className="font-medium">
            Your generated key (already filled in above — shown only in this form):
          </p>
          <code className="break-all">{generated.apiKey}</code>
          <p>
            Put its hash in the target app's environment. This hash is what the plugin checks
            against:
          </p>
          <code className="break-all">AUTHFLEET_API_KEY_HASH={generated.apiKeyHash}</code>
        </div>
      ) : null}
      <div className="grid gap-2 rounded-lg border bg-muted/50 p-4 text-sm">
        <p className="font-medium">Install the plugin in the target app:</p>
        <code>npm install authfleet</code>
        <pre className="overflow-x-auto whitespace-pre-wrap">{PLUGIN_SNIPPET}</pre>
        <p className="text-muted-foreground">
          Using your own key instead? Its hash is: <code>printf %s "YOUR_KEY" | shasum -a 256</code>
        </p>
      </div>
    </>
  );
}
