import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

afterEach(cleanup);

async function renderShell(path = "/") {
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<App router={router} queryClient={queryClient} />);
  await screen.findByRole("banner");
  return view;
}

describe("shell", () => {
  it("renders the top bar and the issue list at /", async () => {
    await renderShell();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("toolbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: /all issues/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "User menu" })).toBeTruthy();
    const main = screen.getByRole("main");
    const section = main.querySelector("section[aria-label='Issues']");
    expect(section).toBeTruthy();
  });

  it("renders no <style> element and no style attribute", async () => {
    // The list sets styles from script (CSSOM), which the CSP allows, and so
    // does the Autocomplete's visually hidden form input; the settings page is
    // where the rest of the markup itself must carry none.
    const { container } = await renderShell("/settings");
    const hidden = "input[aria-hidden=true][tabindex='-1']";
    expect(document.querySelectorAll("style")).toHaveLength(0);
    expect(document.querySelectorAll(`[style]:not(${hidden})`)).toHaveLength(0);
    container.querySelectorAll(hidden).forEach((input) => input.remove());
    expect(container.innerHTML).not.toMatch(/<style|\sstyle=/);
  });

  it("keeps the filter outside the toolbar so arrow keys move the caret", async () => {
    await renderShell();
    const toolbar = screen.getByRole("toolbar");
    const filter = screen.getByRole("combobox", { name: "Filter issues" });
    expect(toolbar.contains(filter)).toBe(false);
    expect(filter.closest("[data-slot=input-group]")).toBeTruthy();

    filter.focus();
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const notPrevented = fireEvent.keyDown(filter, { key });
      expect(notPrevented, key).toBe(true);
    }
    // The Autocomplete moves the caret itself on Home and End.
    const input = filter as HTMLInputElement;
    fireEvent.change(input, { target: { value: "label:bug" } });
    fireEvent.keyDown(filter, { key: "Home" });
    expect(input.selectionStart).toBe(0);
    fireEvent.keyDown(filter, { key: "End" });
    expect(input.selectionStart).toBe(9);
    expect(document.activeElement).toBe(filter);
  });

  it("moves focus along the toolbar with the arrow keys", async () => {
    await renderShell();
    const first = screen.getByRole("button", { name: /all issues/i });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Refresh" }),
      ),
    );
  });
});
