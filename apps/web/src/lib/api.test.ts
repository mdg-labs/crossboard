import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("calls the server's typed routes", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "ok", version: "1.2.3" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await api.api.health.$get();
    const body: { status: "ok"; version: string } = await response.json();
    expect(body).toEqual({ status: "ok", version: "1.2.3" });
    const request = fetchMock.mock.calls[0] as unknown as [string | URL];
    expect(String(request[0])).toMatch(/\/api\/health$/);
  });
});
