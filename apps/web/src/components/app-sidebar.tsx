import type { PublicProject } from "@authfleet/core";
import { Link, useRouterState } from "@tanstack/react-router";
import { FolderKanban, LayoutDashboard, Radar } from "lucide-react";
import * as React from "react";

import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { getOperatorFn, listProjectsFn } from "~/server/api";

/**
 * App shell sidebar (house composition over the generated ui/sidebar
 * primitives). Data comes from the existing server functions, fetched
 * client-side after mount: the root route has no loader, so the shell
 * must never block first paint on the api. While loading we render
 * skeletons; on failure the projects group and operator identity are
 * simply omitted (the pages themselves surface api errors).
 */
export function AppSidebar() {
  const [projects, setProjects] = React.useState<PublicProject[] | null>(null);
  const [operator, setOperator] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([listProjectsFn(), getOperatorFn()])
      .then(([{ projects: list }, { operator: name }]) => {
        if (cancelled) return;
        setProjects(list);
        setOperator(name);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchProject = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown> | undefined)?.project,
  });
  const onDashboard = pathname === "/";
  // Mirror the dashboard loader: ?project= wins, else the first project.
  const activeProjectId = typeof searchProject === "string" ? searchProject : projects?.[0]?.id;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="AuthFleet"
              render={<Link to="/" search={{ project: undefined }} />}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Radar className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">AuthFleet</span>
                <span className="truncate text-xs text-muted-foreground">
                  Better Auth dashboard
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Dashboard"
                isActive={onDashboard}
                render={<Link to="/" search={{ project: undefined }} />}
              >
                <LayoutDashboard />
                <span>Dashboard</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Projects"
                isActive={pathname === "/projects"}
                render={<Link to="/projects" />}
              >
                <FolderKanban />
                <span>Projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {projects === null && !failed ? (
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        {projects !== null && projects.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarMenu>
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    tooltip={project.name}
                    isActive={onDashboard && project.id === activeProjectId}
                    render={<Link to="/" search={{ project: project.id }} />}
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        project.type === "agent" ? "bg-emerald-500" : "bg-sky-500",
                      )}
                    />
                    <span className="truncate">
                      {project.name}
                      {project.isDemo ? " (demo)" : ""}
                    </span>
                    <SidebarMenuBadge>
                      {project.type === "agent" ? "Plugin" : "D1"}
                    </SidebarMenuBadge>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 px-2 py-1.5">
              {operator === null && !failed ? (
                <>
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="grid flex-1 gap-1.5">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                </>
              ) : (
                <>
                  <Avatar className="size-8 shrink-0">
                    <AvatarFallback>
                      {(operator ?? "?").trim().charAt(0).toUpperCase() || "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{operator ?? "Unknown operator"}</span>
                    <span className="truncate text-xs text-muted-foreground">Operator</span>
                  </div>
                </>
              )}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
