import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";

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

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
            <Link to="/" search={{ project: undefined }} className="font-semibold tracking-tight">
              AuthFleet
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link
                to="/"
                search={{ project: undefined }}
                className="hover:text-foreground [&.active]:text-foreground"
              >
                Dashboard
              </Link>
              <Link to="/projects" className="hover:text-foreground [&.active]:text-foreground">
                Projects
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}
