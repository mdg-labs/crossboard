import { useRef } from "react";
import { IssueDetail } from "@/components/detail/issue-detail";
import { Drawer, DrawerPanel, DrawerPopup } from "@/components/ui/drawer";
import type { IssueRef } from "@/lib/issue-detail";

/**
 * The detail as a non-modal Drawer from the right (SPEC FR-39, D-22): the
 * list behind it keeps its keyboard and pointer, so only Esc and the close
 * button dismiss it.
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
        aria-label="Issue detail"
        className="max-w-2xl"
        data-detail-panel=""
        finalFocus={false}
        initialFocus={false}
        showCloseButton
        variant="straight"
      >
        <DrawerPanel>
          {shown.current === null ? null : (
            <IssueDetail issue={shown.current} onOpenIssue={onOpenIssue} />
          )}
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
