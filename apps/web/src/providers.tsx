import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

export function AppProviders({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <CSPProvider disableStyleElements>
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    </CSPProvider>
  );
}
