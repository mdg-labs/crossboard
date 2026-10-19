import { useRef } from "react";
import { DrawerDetailHeader } from "@/components/detail/detail-header";
import { IssueDetail } from "@/components/detail/issue-detail";
import { useDetailExpanded } from "@/components/detail/use-detail-expanded";
import { Drawer, DrawerPanel, DrawerPopup } from "@/components/ui/drawer";
import type { IssueRef } from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

/**
 * The detail as a non-modal Drawer from the right (SPEC FR-39, D-22): the
 * list behind it keeps its keyboard and pointer, so only Esc and the close
 * button dismiss it. Its header toggles full screen in place (D-25).
 */
export function DetailDrawer({
  issue,
  onClose,
  onOpenIssue,
}: {
  /** The issue to show; `null` closes the Drawer. */
  issue: IssueRef | null;
  onClose: () => void;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  // The content stays while the Drawer slides out.
  const shown = useRef(issue);
  if (issue !== null) {
    shown.current = issue;
  }
  const [expanded, setExpanded] = useDetailExpanded();

  return (
    <Drawer
      disablePointerDismissal
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={issue !== null}
      position="right"
    >
      <DrawerPopup
        className={cn(expanded ? "w-full max-w-none" : "max-w-2xl")}
        data-detail-panel=""
        finalFocus={false}
        initialFocus={false}
        variant="straight"
      >
        {shown.current === null ? null : (
          <>
            <DrawerDetailHeader
              expanded={expanded}
              issue={shown.current}
              onExpandedChange={setExpanded}
            />
            <DrawerPanel>
              <IssueDetail
                issue={shown.current}
                onOpenIssue={onOpenIssue}
                wide={expanded}
              />
            </DrawerPanel>
          </>
        )}
      </DrawerPopup>
    </Drawer>
  );
}
