import { useState } from "react";
import { BoardCard, type CardActions } from "@/components/board/board-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BoardCard as CardData } from "@/lib/board-cards";

/** Cards one column renders before "Show N more" (SPEC FR-32). */
export const COLUMN_CARD_LIMIT = 200;

/**
 * One column of a board: its name, the number of top-level cards, and the
 * cards in a Scroll Area. Only the first 200 cards are rendered; a Button
 * reveals the rest.
 */
export function BoardColumn({
  name,
  count,
  cards,
  actions,
}: {
  name: string;
  count: number;
  cards: CardData[];
  actions: CardActions;
}): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? cards : cards.slice(0, COLUMN_CARD_LIMIT);
  const hidden = cards.length - shown.length;

  return (
    <section
      aria-label={name}
      className="flex w-80 shrink-0 flex-col self-stretch rounded-2xl border bg-muted/40"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <h2 className="truncate font-medium text-sm">{name}</h2>
        <Badge aria-label={`${count} cards`} variant="outline">
          {count}
        </Badge>
      </header>
      <ScrollArea className="flex-1" scrollFade scrollbarGutter>
        <div className="flex flex-col gap-2 px-2 pb-2">
          {shown.map((card) => (
            <BoardCard actions={actions} card={card} key={card.id} />
          ))}
          {hidden > 0 ? (
            <Button
              onClick={() => setShowAll(true)}
              size="sm"
              variant="outline"
            >
              Show {hidden} more
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}
