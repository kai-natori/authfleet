import type { PublicProject } from "@authfleet/core";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  CalendarPlus,
  Check,
  ChevronsUpDown,
  FolderPlus,
  Ghost,
  type LucideIcon,
  UserPlus,
  Users,
} from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
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

/** Same label the project switcher has always shown (name + suffixes). */
function projectLabel(project: PublicProject): string {
  return `${project.name}${project.type === "agent" ? " · Plugin" : ""}${project.isDemo ? " (demo)" : ""}`;
}

function StatCard(props: { title: string; value: string; description?: string; icon: LucideIcon }) {
  const Icon = props.icon;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{props.title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{props.value}</div>
        {props.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const totalUsersChartConfig = {
  total: { label: "Total users", color: "var(--chart-1)" },
} satisfies ChartConfig;

const signupsChartConfig = {
  count: { label: "Signups", color: "var(--chart-2)" },
} satisfies ChartConfig;

function DashboardPage() {
  const { projects, operator, selectedId, selectedType, stats } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <FolderPlus className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">No projects yet</h1>
          <p className="text-muted-foreground">
            Register your first Better Auth project to see its user counts here. Signed in as{" "}
            {operator}.
          </p>
        </div>
        <Button render={<Link to="/projects" />}>Add a project</Button>
      </div>
    );
  }

  const selectedProject = projects.find((p) => p.id === selectedId);
  const summary = stats?.ok ? stats.data.summary : undefined;
  const growth = summary?.growth;

  const snapshotData = summary
    ? [...summary.snapshots]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((snap) => ({ date: snap.date, total: snap.totalUsers }))
    : [];
  const signupData = summary
    ? [...summary.stats.dailySignups]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({ date: day.date, count: day.count }))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Operator: {operator}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" className="w-64 justify-between" />}
          >
            <span className="truncate">
              {selectedProject ? projectLabel(selectedProject) : "Select a project"}
            </span>
            <ChevronsUpDown className="shrink-0 opacity-50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Projects</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => void navigate({ search: { project: project.id } })}
              >
                <span className="flex-1 truncate">{projectLabel(project)}</span>
                {project.id === selectedId ? <Check /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
            <StatCard
              title="Total users"
              value={summary.stats.totalUsers.toLocaleString()}
              icon={Users}
            />
            <StatCard
              title="New users (7d)"
              value={summary.newLast7Days.toLocaleString()}
              icon={UserPlus}
            />
            <StatCard
              title="New users (30d)"
              value={summary.newLast30Days.toLocaleString()}
              icon={CalendarPlus}
            />
            {summary.stats.anonymousUsers !== null ? (
              <StatCard
                title="Anonymous (guest) users"
                value={summary.stats.anonymousUsers.toLocaleString()}
                description="Included in the total above."
                icon={Ghost}
              />
            ) : (
              <StatCard
                title="Anonymous (guest) users"
                value="—"
                description="No anonymous column in this project's user table."
                icon={Ghost}
              />
            )}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Total users</CardTitle>
                <CardDescription>
                  {growth
                    ? `${growth.firstTotal.toLocaleString()} users on ${growth.firstDate} → ${growth.latestTotal.toLocaleString()} on ${growth.latestDate} (${growth.delta >= 0 ? "+" : ""}${growth.delta.toLocaleString()}${growth.deltaPercent !== null ? `, ${growth.deltaPercent.toFixed(1)}%` : ""} over ${growth.spanDays} days, from daily snapshots)`
                    : "Not enough snapshots yet — the api Worker records one per day, and growth appears once two exist."}
                </CardDescription>
              </CardHeader>
              {growth ? (
                <CardContent>
                  <ChartContainer
                    config={totalUsersChartConfig}
                    className="aspect-auto h-[280px] w-full"
                  >
                    <AreaChart
                      accessibilityLayer
                      data={snapshotData}
                      margin={{ left: 4, right: 12 }}
                    >
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={32}
                        tickFormatter={(value: string) => value.slice(5)}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={52}
                        tickFormatter={(value: number) => value.toLocaleString()}
                      />
                      <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent indicator="line" />}
                      />
                      <defs>
                        <linearGradient id="fillTotalUsers" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.1} />
                        </linearGradient>
                      </defs>
                      <Area
                        dataKey="total"
                        type="natural"
                        fill="url(#fillTotalUsers)"
                        stroke="var(--color-total)"
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ChartContainer>
                </CardContent>
              ) : null}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Signups per day</CardTitle>
                <CardDescription>Last 30 days</CardDescription>
              </CardHeader>
              <CardContent>
                {signupData.length > 0 ? (
                  <ChartContainer
                    config={signupsChartConfig}
                    className="aspect-auto h-[280px] w-full"
                  >
                    <BarChart accessibilityLayer data={signupData} margin={{ left: 4, right: 12 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={24}
                        tickFormatter={(value: string) => value.slice(5)}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={36}
                        allowDecimals={false}
                      />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                      <Bar
                        dataKey="count"
                        fill="var(--color-count)"
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No signup data available.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            Stats read live at {new Date(summary.stats.asOf).toLocaleString()}.
            {stats?.ok && stats.data.project.isDemo ? (
              <>
                {" "}
                <Badge variant="secondary">demo data</Badge>
              </>
            ) : null}
          </p>
        </>
      ) : null}
    </div>
  );
}
