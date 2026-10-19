import { useState } from "react";

const storageKey = (boardId: number): string =>
  `crossboard:board:${String(boardId)}:expanded`;

/** The cards the viewer expanded; none when storage is unavailable or holds junk. */
function readExpanded(boardId: number): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(boardId));
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
 * Which cards of a board show their nested sub-issues (SPEC FR-31). The set
 * lives in `localStorage` under `crossboard:board:<boardId>:expanded`; where
 * storage is unavailable every card starts collapsed and the toggles still
 * work until the page is left.
 */
export function useExpandedCards(boardId: number): {
  isExpanded: (cardId: string) => boolean;
  setExpanded: (cardId: string, expanded: boolean) => void;
} {
  const [expanded, setExpandedSet] = useState(() => readExpanded(boardId));
  return {
    isExpanded: (cardId) => expanded.has(cardId),
    setExpanded: (cardId, open) => {
      const next = new Set(expanded);
      if (open) {
        next.add(cardId);
      } else {
        next.delete(cardId);
      }
      setExpandedSet(next);
      try {
        window.localStorage.setItem(
          storageKey(boardId),
          JSON.stringify([...next]),
        );
      } catch {
        // Storage is full or blocked; the state stays for this page only.
      }
    },
  };
}
