import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AppProviders } from "@/providers";
import type { AppRouter } from "@/router";

export function App({
  router,
  queryClient,
}: {
  router: AppRouter;
  queryClient: QueryClient;
}): React.ReactElement {
  return (
    <AppProviders>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppProviders>
  );
}
