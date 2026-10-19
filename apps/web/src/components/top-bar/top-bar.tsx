import { FilterBar } from "@/components/filter-bar/filter-bar";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { SyncStatus } from "@/components/top-bar/sync-status";
import { UserMenu } from "@/components/top-bar/user-menu";
import { ViewSwitcher } from "@/components/view-switcher/view-switcher";

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
          <SyncStatus />
          <UserMenu />
        </ToolbarGroup>
      </Toolbar>
      <FilterBar />
    </header>
  );
}
