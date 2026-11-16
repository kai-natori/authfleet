import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import { AppSidebar } from "~/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "~/components/ui/breadcrumb";
import { Separator } from "~/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import appCss from "~/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AuthFleet" },
      {
        name: "description",
        content: "One dashboard for all your Better Auth apps — self-hosted on Cloudflare.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootDocument,
});

/** Slim top bar inside the inset: sidebar trigger + current page label. */
function PageHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const label = pathname === "/projects" ? "Projects" : "Dashboard";
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <PageHeader />
              <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
                <Outlet />
              </div>
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
