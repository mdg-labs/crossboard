import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

afterEach(cleanup);

describe("/auth/not-allowed", () => {
  it("says the account is not allowed on this instance, outside the app shell", async () => {
    const queryClient = createQueryClient();
    const router = createAppRouter({
      queryClient,
      history: createMemoryHistory({ initialEntries: ["/auth/not-allowed"] }),
    });
    render(<App router={router} queryClient={queryClient} />);

    expect(await screen.findByText("This account is not allowed")).toBeTruthy();
    expect(screen.getByText(/not allowed on this instance/i)).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(router.state.location.pathname).toBe("/auth/not-allowed");
  });

  it("offers a link back to sign-in", async () => {
    const queryClient = createQueryClient();
    const router = createAppRouter({
      queryClient,
      history: createMemoryHistory({ initialEntries: ["/auth/not-allowed"] }),
    });
    render(<App router={router} queryClient={queryClient} />);

    const link = await screen.findByRole("link", {
      name: "Sign in with another account",
    });
    expect(link.getAttribute("href")).toBe("/auth/login");
  });
});
