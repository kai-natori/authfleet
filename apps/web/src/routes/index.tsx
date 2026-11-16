import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { pluginStatusInfo } from "~/lib/plugin-status";
import { getOperatorFn, getProjectStatsFn, listProjectsFn } from "~/server/api";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ deps }) => {
    const [{ projects }, { operator }] = await Promise.all([listProjectsFn(), getOperatorFn()]);
    const selected = projects.find((p) => p.id === deps.project) ?? projects[0];
    const stats = selected ? await getProjectStatsFn({ data: selected.id }) : null;
    return {
      projects,
      operator: operator ?? "unknown",
      selectedId: selected?.id,
      selectedType: selected?.type,
      stats,
    };
  },
  component: DashboardPage,
});

function StatCard(props: { title: string; value: string; description?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{props.title}</CardDescription>
        <CardTitle className="text-3xl">{props.value}</CardTitle>
      </CardHeader>
      {props.description ? (
        <CardContent className="text-sm text-muted-foreground">{props.description}</CardContent>
      ) : null}
    </Card>
  );
}

function DashboardPage() {
  const { projects, operator, selectedId, selectedType, stats } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  if (projects.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">No projects yet</h1>
        <p className="text-muted-foreground">
          Register your first Better Auth project to see its user counts here. Signed in as{" "}
          {operator}.
        </p>
        <Link to="/projects" className="text-primary underline underline-offset-4">
          Add a project
        </Link>
      </div>
    );
  }

  const summary = stats?.ok ? stats.data.summary : undefined;
  const growth = summary?.growth;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Operator: {operator}</p>
        </div>
        <Select
          value={selectedId}
          onValueChange={(value) => {
            if (typeof value === "string") {
              void navigate({ search: { project: value } });
            }
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
                {project.type === "agent" ? " · Plugin" : ""}
                {project.isDemo ? " (demo)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {stats && !stats.ok ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {stats.pluginStatus
                ? pluginStatusInfo(stats.pluginStatus).label
                : "Could not load statistics"}
              {selectedType === "agent" ? <Badge variant="outline">Plugin</Badge> : null}
            </CardTitle>
            <CardDescription>
              {stats.pluginStatus ? pluginStatusInfo(stats.pluginStatus).description : stats.error}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {summary ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Total users" value={summary.stats.totalUsers.toLocaleString()} />
            <StatCard title="New users (7d)" value={summary.newLast7Days.toLocaleString()} />
            <StatCard title="New users (30d)" value={summary.newLast30Days.toLocaleString()} />
            {summary.stats.anonymousUsers !== null ? (
              <StatCard
                title="Anonymous (guest) users"
                value={summary.stats.anonymousUsers.toLocaleString()}
                description="Included in the total above."
              />
            ) : (
              <StatCard
                title="Anonymous (guest) users"
                value="—"
                description="No anonymous column in this project's user table."
              />
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Growth</CardTitle>
              <CardDescription>
                {growth
                  ? `${growth.firstTotal.toLocaleString()} users on ${growth.firstDate} → ${growth.latestTotal.toLocaleString()} on ${growth.latestDate} (${growth.delta >= 0 ? "+" : ""}${growth.delta.toLocaleString()}${growth.deltaPercent !== null ? `, ${growth.deltaPercent.toFixed(1)}%` : ""} over ${growth.spanDays} days, from daily snapshots)`
                  : "Not enough snapshots yet — the api Worker records one per day, and growth appears once two exist."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-medium">Signups per day (last 30 days)</h3>
                  <ul className="space-y-1 text-sm">
                    {[...summary.stats.dailySignups]
                      .reverse()
                      .slice(0, 14)
                      .map((day) => (
                        <li
                          key={day.date}
                          className="flex justify-between border-b py-1 last:border-0"
                        >
                          <span className="text-muted-foreground">{day.date}</span>
                          <span className="font-medium">{day.count}</span>
                        </li>
                      ))}
                    {summary.stats.dailySignups.length === 0 ? (
                      <li className="text-muted-foreground">No signup data available.</li>
                    ) : null}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">Snapshots</h3>
                  <ul className="space-y-1 text-sm">
                    {[...summary.snapshots]
                      .reverse()
                      .slice(0, 14)
                      .map((snap) => (
                        <li
                          key={snap.id}
                          className="flex justify-between border-b py-1 last:border-0"
                        >
                          <span className="text-muted-foreground">{snap.date}</span>
                          <span className="font-medium">{snap.totalUsers.toLocaleString()}</span>
                        </li>
                      ))}
                    {summary.snapshots.length === 0 ? (
                      <li className="text-muted-foreground">No snapshots yet.</li>
                    ) : null}
                  </ul>
                </div>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Stats read live at {new Date(summary.stats.asOf).toLocaleString()}.
                {stats?.ok && stats.data.project.isDemo ? (
                  <>
                    {" "}
                    <Badge variant="secondary">demo data</Badge>
                  </>
                ) : null}
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
