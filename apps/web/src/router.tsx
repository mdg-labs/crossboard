import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { TopBar } from "@/components/top-bar/top-bar";
import { IndexRoute } from "@/routes/index";

interface RouterContext {
  queryClient: QueryClient;
}

function Shell(): React.ReactElement {
  return (
    <div className="isolate flex h-dvh min-w-5xl flex-col">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRoute,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export function createAppRouter(options: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient },
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
