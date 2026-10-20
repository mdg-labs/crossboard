import { useState } from "react";

const STORAGE_KEY = "crossboard:detail:expanded";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Whether the detail Drawer fills the viewport (SPEC FR-39, D-25). The choice
 * lives in `localStorage` under `crossboard:detail:expanded`; where storage
 * is unavailable the panel starts as a side panel and the toggle still works
 * until the page is left.
 */
export function useDetailExpanded(): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpandedState] = useState(readExpanded);
  return [
    expanded,
    (next) => {
      setExpandedState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Storage is full or blocked; the choice stays for this page only.
      }
    },
  ];
}
