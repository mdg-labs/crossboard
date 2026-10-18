import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Group } from "@/components/ui/group";
import { Input } from "@/components/ui/input";
import { Toolbar, ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { UserMenu } from "@/components/top-bar/user-menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

export function TopBar(): React.ReactElement {
  return (
    <header className="grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-4">
      <Toolbar
        aria-label="Views and account"
        className="contents border-0 bg-transparent p-0"
      >
        <ToolbarGroup className="col-start-1 row-start-1">
          <ToolbarButton render={<Button size="sm" variant="ghost" />}>
            All issues
            <ChevronDownIcon aria-hidden="true" />
          </ToolbarButton>
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
      <Group
        aria-label="Filter"
        className="col-start-2 row-start-1 w-full max-w-2xl justify-self-center"
      >
        <Input
          aria-label="Filter issues"
          placeholder="Filter issues"
          type="text"
        />
      </Group>
    </header>
  );
}
