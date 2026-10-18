import { ScrollArea } from "@/components/ui/scroll-area";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders } from "@/providers";

afterEach(cleanup);

describe("AppProviders", () => {
  it("stops Base UI from rendering its scrollbar <style> element", () => {
    render(
      <AppProviders>
        <ScrollArea>content</ScrollArea>
      </AppProviders>,
    );
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });

  it("is the reason: the same ScrollArea outside it renders one", () => {
    render(<ScrollArea>content</ScrollArea>);
    expect(document.querySelectorAll("style").length).toBeGreaterThan(0);
  });
});
