import { ExternalLink } from "@/components/detail/issue-link";
import { Person } from "@/components/detail/person";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardPanel } from "@/components/ui/card";

/**
 * One comment, or the description, as its own card (SPEC FR-40): who wrote
 * it, when, linked to where it lives on GitHub, and its sanitized body.
 */
export function CommentCard({
  author,
  avatarUrl,
  origin,
  isIssueAuthor,
  headline,
  timestamp,
  url,
  render,
  children,
}: {
  author: string;
  avatarUrl: string | null;
  origin: string;
  /** Marks the card with an "Author" badge when its writer opened the issue. */
  isIssueAuthor: boolean;
  /** What the writer did, when the card is not a comment. */
  headline?: string;
  timestamp: number;
  url: string;
  /** Renders the card as another element, such as a list item. */
  render?: React.ReactElement;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="bg-muted/30" render={render}>
      <CardHeader className="flex items-center gap-2 border-b px-4 py-2.5 text-sm in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-2.5">
        <Person avatarUrl={avatarUrl} login={author} origin={origin} />
        {isIssueAuthor ? (
          <Badge size="sm" variant="outline">
            Author
          </Badge>
        ) : null}
        {headline === undefined ? null : (
          <span className="text-muted-foreground">{headline}</span>
        )}
        <ExternalLink
          className="ms-auto text-muted-foreground hover:underline"
          href={url}
        >
          <RelativeTime timestamp={timestamp} />
        </ExternalLink>
      </CardHeader>
      <CardPanel className="min-w-0 px-4 py-3">{children}</CardPanel>
    </Card>
  );
}
