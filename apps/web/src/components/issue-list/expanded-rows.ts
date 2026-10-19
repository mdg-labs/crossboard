import { useState } from "react";

const STORAGE_KEY = "crossboard:list:expanded";

/** The rows the viewer expanded this session; none when storage is unavailable or holds junk. */
function readExpanded(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Which rows of the nested list show their sub-issues (SPEC FR-12). The set
 * lives in `sessionStorage` under `crossboard:list:expanded`, so it survives
 * a reload of the tab and not the tab; where storage is unavailable every row
 * starts collapsed and the toggles still work until the page is left.
 */
export function useExpandedRows(): {
  isExpanded: (issueId: string) => boolean;
  setExpanded: (issueId: string, expanded: boolean) => void;
} {
  const [expanded, setExpandedSet] = useState(readExpanded);
  return {
    isExpanded: (issueId) => expanded.has(issueId),
    setExpanded: (issueId, open) => {
      const next = new Set(expanded);
      if (open) {
        next.add(issueId);
      } else {
        next.delete(issueId);
      }
      setExpandedSet(next);
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Storage is full or blocked; the state stays for this page only.
      }
    },
  };
}
