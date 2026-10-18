import { createMemoryHistory } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const manifestResponse = {
  manifest: { name: "Crossboard (localhost:3000)", public: true },
  url: "https://github.com/organizations/acme/settings/apps/new",
  state: "s t/a",
};

function stubFetch(
  handler: (path: string, init: RequestInit | undefined) => Response,
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    return handler(new URL(url, window.location.origin).pathname, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function renderSetup() {
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ["/setup"] }),
  });
  render(<App router={router} queryClient={queryClient} />);
  await screen.findByLabelText("Setup token");
  return router;
}

async function enterToken(token: string) {
  fireEvent.change(await screen.findByLabelText("Setup token"), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("/setup", () => {
  it("shows the error for a wrong token and stays on /setup", async () => {
    const fetchMock = stubFetch(() =>
      Response.json(
        { error: { code: "unauthorized", message: "Invalid setup token" } },
        { status: 401 },
      ),
    );
    const router = await renderSetup();

    await enterToken("wrong");

    expect(await screen.findByText(/setup token is not valid/i)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/setup");
    expect(screen.queryByLabelText("App name")).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ token: "wrong" });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("shows a connection error instead of moving on when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    await renderSetup();

    await enterToken("abc");

    expect(await screen.findByText(/could not be reached/i)).toBeTruthy();
    expect(screen.queryByLabelText("App name")).toBeNull();
  });

  it("asks for the account and app name after the token and posts the manifest to GitHub", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    const fetchMock = stubFetch((path) =>
      path === "/api/setup/token"
        ? new Response(null, { status: 204 })
        : Response.json(manifestResponse),
    );
    await renderSetup();

    await enterToken("right");

    const name = await screen.findByLabelText<HTMLInputElement>("App name");
    expect(name.value).toBe(`Crossboard (${window.location.host})`);
    fireEvent.change(screen.getByLabelText("Owning organization"), {
      target: { value: "acme" },
    });
    fireEvent.change(name, { target: { value: "Acme Board" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to GitHub" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      organization: "acme",
      name: "Acme Board",
    });
    const form = submit.mock.contexts[0] as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe(
      `${manifestResponse.url}?state=s%20t%2Fa`,
    );
    const field = form.elements.namedItem("manifest") as HTMLInputElement;
    expect(JSON.parse(field.value)).toEqual(manifestResponse.manifest);
  });

  it("omits the organization for a personal account and shows a manifest error", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    const fetchMock = stubFetch((path) =>
      path === "/api/setup/token"
        ? new Response(null, { status: 204 })
        : Response.json(
            { error: { code: "bad_request", message: "Invalid request" } },
            { status: 400 },
          ),
    );
    await renderSetup();
    await enterToken("right");
    await screen.findByLabelText("App name");

    fireEvent.click(screen.getByRole("button", { name: "Continue to GitHub" }));

    expect(await screen.findByText("Invalid request")).toBeTruthy();
    const [, init] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      name: `Crossboard (${window.location.host})`,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns to the token step when the setup session has expired", async () => {
    stubFetch((path) =>
      path === "/api/setup/token"
        ? new Response(null, { status: 204 })
        : Response.json(
            {
              error: { code: "unauthorized", message: "Setup token required" },
            },
            { status: 401 },
          ),
    );
    await renderSetup();
    await enterToken("right");
    await screen.findByLabelText("App name");

    fireEvent.click(screen.getByRole("button", { name: "Continue to GitHub" }));

    expect(await screen.findByText(/setup session has expired/i)).toBeTruthy();
    expect(screen.getByLabelText("Setup token")).toBeTruthy();
  });

  it("makes step two submittable again when the page is restored from the back/forward cache", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    let manifests = 0;
    const fetchMock = stubFetch((path) =>
      path === "/api/setup/token"
        ? new Response(null, { status: 204 })
        : Response.json({ ...manifestResponse, state: `state-${++manifests}` }),
    );
    await renderSetup();
    await enterToken("right");
    await screen.findByLabelText("App name");
    const button = screen.getByRole("button", { name: "Continue to GitHub" });

    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute("data-loading")).toBe(true));

    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(restored);
    });

    await waitFor(() =>
      expect(button.hasAttribute("data-loading")).toBe(false),
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls).toHaveLength(3);
    const form = submit.mock.contexts[1] as HTMLFormElement;
    expect(form.getAttribute("action")).toBe(
      `${manifestResponse.url}?state=state-2`,
    );
  });

  it("keeps the submission pending on a pageshow that is not a cache restore", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    stubFetch((path) =>
      path === "/api/setup/token"
        ? new Response(null, { status: 204 })
        : Response.json(manifestResponse),
    );
    await renderSetup();
    await enterToken("right");
    await screen.findByLabelText("App name");
    const button = screen.getByRole("button", { name: "Continue to GitHub" });
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    const fresh = new Event("pageshow");
    Object.defineProperty(fresh, "persisted", { value: false });
    act(() => {
      window.dispatchEvent(fresh);
    });

    expect(button.hasAttribute("data-loading")).toBe(true);
  });
});
