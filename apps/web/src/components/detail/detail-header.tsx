import { useQuery } from "@tanstack/react-query";
import {
  ExternalLinkIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { Fragment } from "react";
import { IssueLink } from "@/components/detail/issue-link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DrawerClose, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type IssueAncestor,
  type IssueRef,
  issueSummaryQuery,
  refLabel,
} from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

const TITLE_CLASS = "font-medium font-sans text-sm leading-tight tabular-nums";

function IconTooltip({
  label,
  render,
  children,
}: {
  label: string;
  render: React.ReactElement;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The ancestor chain (SPEC FR-40), the topmost issue first. A synced ancestor
 * opens its detail; any other goes to GitHub.
 */
function AncestorBreadcrumb({
  ancestors,
  onOpenIssue,
}: {
  ancestors: IssueAncestor[];
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  return (
    <Breadcrumb aria-label="Ancestors" className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1 text-xs sm:gap-1">
        {[...ancestors].reverse().map((ancestor, index) => (
          <Fragment key={refLabel(ancestor)}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem className="min-w-0">
              <IssueLink
                className="truncate tabular-nums hover:text-foreground hover:underline"
                issue={ancestor}
                onOpenIssue={onOpenIssue}
                synced={ancestor.synced}
                title={ancestor.title}
                url={ancestor.url}
              >
                {refLabel(ancestor)}
              </IssueLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The left of the header row, its ref and the ancestor breadcrumb, and the
 * "Open on GitHub" action; the host adds its own controls after them. The
 * summary comes from the cache the detail body fills.
 */
function HeaderRow({
  issue,
  title,
  actions,
  onOpenIssue,
}: {
  issue: IssueRef;
  title: React.ReactElement;
  actions: React.ReactNode;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  const summary = useQuery(issueSummaryQuery(issue)).data;
  const ancestors = summary?.ancestors ?? [];

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {title}
        {ancestors.length === 0 ? null : (
          <AncestorBreadcrumb ancestors={ancestors} onOpenIssue={onOpenIssue} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {summary === undefined ? null : (
          <IconTooltip
            label="Open on GitHub"
            render={
              <Button
                aria-label="Open on GitHub"
                render={
                  <a
                    href={summary.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <ExternalLinkIcon aria-hidden="true" />
          </IconTooltip>
        )}
        {actions}
      </div>
    </>
  );
}

const ROW_CLASS = "h-12 flex-row items-center gap-3 border-b px-4 py-0";

/**
 * The detail Drawer's header (SPEC FR-39): one row with the issue ref as the
 * Drawer's title, the ancestor breadcrumb, "Open on GitHub", the full-screen toggle
 * and the close button.
 */
export function DrawerDetailHeader({
  issue,
  expanded,
  onExpandedChange,
  onOpenIssue,
}: {
  issue: IssueRef;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  return (
    <DrawerHeader
      className={cn(
        ROW_CLASS,
        "in-[[data-slot=drawer-popup]:has([data-slot=drawer-panel])]:pb-0 max-sm:pb-0",
      )}
    >
      <HeaderRow
        actions={
          <>
            <IconTooltip
              label={expanded ? "Exit full screen" : "Full screen"}
              render={
                <Toggle
                  aria-label="Full screen"
                  onPressedChange={onExpandedChange}
                  pressed={expanded}
                  size="sm"
                />
              }
            >
              {expanded ? (
                <Minimize2Icon aria-hidden="true" />
              ) : (
                <Maximize2Icon aria-hidden="true" />
              )}
            </IconTooltip>
            <Separator className="mx-1 h-4" orientation="vertical" />
            <IconTooltip
              label="Close"
              render={
                <DrawerClose
                  render={
                    <Button aria-label="Close" size="icon-sm" variant="ghost" />
                  }
                />
              }
            >
              <XIcon aria-hidden="true" />
            </IconTooltip>
          </>
        }
        issue={issue}
        onOpenIssue={onOpenIssue}
        title={
          <DrawerTitle className={TITLE_CLASS}>{refLabel(issue)}</DrawerTitle>
        }
      />
    </DrawerHeader>
  );
}

/** The same header row on the `/i/:owner/:repo/:number` page, which has no panel to resize or close. */
export function PageDetailHeader({
  issue,
  onOpenIssue,
}: {
  issue: IssueRef;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  return (
    <div className={cn("flex", ROW_CLASS)}>
      <HeaderRow
        actions={null}
        issue={issue}
        onOpenIssue={onOpenIssue}
        title={<p className={TITLE_CLASS}>{refLabel(issue)}</p>}
      />
    </div>
  );
}
