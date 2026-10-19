import { ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

/** One collapsible block of the detail view, closed off by a separator. */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 py-3 text-left font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
          />
          {title}
          {count === undefined ? null : (
            <Badge size="sm" variant="secondary">
              {count}
            </Badge>
          )}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 pb-4">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
      <Separator />
    </>
  );
}
