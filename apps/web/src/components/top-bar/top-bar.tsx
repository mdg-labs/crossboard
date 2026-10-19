import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/filter-bar/filter-bar";
import { Toolbar, ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { UserMenu } from "@/components/top-bar/user-menu";
import { ViewSwitcher } from "@/components/view-switcher/view-switcher";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

export function TopBar(): React.ReactElement {
  return (
    <header className="grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-4">
      <Toolbar
        aria-label="Views and account"
        className="contents border-0 bg-transparent p-0"
      >
        <ToolbarGroup className="col-start-1 row-start-1">
          <ViewSwitcher />
        </ToolbarGroup>
        <ToolbarGroup className="col-start-3 row-start-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <ToolbarButton
                  render={
                    <Button
                      aria-label="Sync status"
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                />
              }
            >
              <RefreshCwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>Sync status</TooltipPopup>
          </Tooltip>
          <UserMenu />
        </ToolbarGroup>
      </Toolbar>
      <FilterBar />
    </header>
  );
}
