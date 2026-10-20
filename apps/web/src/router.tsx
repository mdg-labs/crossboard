import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  retainSearchParams,
  type RouterHistory,
} from "@tanstack/react-router";
import { TopBar } from "@/components/top-bar/top-bar";
import { parseBoardSearch } from "@/lib/board-cards";
import { parseIndexSearch } from "@/lib/issues";
import { BoardRoute } from "@/routes/board";
import { BoardEditRoute, BoardNewRoute } from "@/routes/board-edit";
import { IndexRoute } from "@/routes/index";
import { IssueRoute } from "@/routes/issue";
import { NotAllowedRoute } from "@/routes/not-allowed";
import { SettingsRoute } from "@/routes/settings";
import { SetupRoute } from "@/routes/setup";

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
  component: Outlet,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  validateSearch: parseIndexSearch,
  // The nesting mode is a display setting: setting a filter, a sort or a
  // saved view from the top bar leaves it as it is.
  search: { middlewares: [retainSearchParams(["nest"])] },
  component: IndexRoute,
});

const issueRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/i/$owner/$repo/$number",
  component: IssueRoute,
});

const boardNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/b/new",
  component: BoardNewRoute,
});

const boardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/b/$boardId",
  validateSearch: parseBoardSearch,
  component: BoardRoute,
});

const boardEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/b/$boardId/edit",
  component: BoardEditRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsRoute,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupRoute,
});

const notAllowedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/not-allowed",
  component: NotAllowedRoute,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    indexRoute,
    issueRoute,
    boardNewRoute,
    boardRoute,
    boardEditRoute,
    settingsRoute,
  ]),
  setupRoute,
  notAllowedRoute,
]);

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
