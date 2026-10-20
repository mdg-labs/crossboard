import {
  ExternalLink,
  githubOrigin,
  labelUrl,
  repoUrl,
} from "@/components/detail/issue-link";
import { Person } from "@/components/detail/person";
import { issueTypeColors, labelColors } from "@/components/issue-list/colors";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Badge } from "@/components/ui/badge";
import type { IssueRef, IssueSummary } from "@/lib/issue-detail";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </dd>
    </>
  );
}

/**
 * The issue's fields (SPEC FR-40). Beside the content in full screen it is
 * the properties rail; otherwise it is the field list above the sections.
 */
export function PropertiesRail({
  summary,
  className,
}: {
  summary: IssueSummary;
  className?: string;
}): React.ReactElement {
  const origin = githubOrigin(summary.url);
  const ref: IssueRef = {
    owner: summary.repo.owner,
    repo: summary.repo.name,
    number: summary.number,
  };

  return (
    <aside aria-label="Properties" className={className}>
      <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <Field label="Repository">
          <ExternalLink
            className="hover:underline"
            href={repoUrl(origin, ref.owner, ref.repo)}
          >
            {ref.owner}/{ref.repo}
          </ExternalLink>
        </Field>
        <Field label="Author">
          <Person avatarUrl={null} login={summary.author} origin={origin} />
        </Field>
        <Field label="Created">
          <RelativeTime timestamp={summary.createdAt} />
        </Field>
        <Field label="Updated">
          <RelativeTime timestamp={summary.updatedAt} />
        </Field>
        {summary.type === null ? null : (
          <Field label="Type">
            <Badge style={issueTypeColors(summary.type.color)}>
              {summary.type.name}
            </Badge>
          </Field>
        )}
        {summary.milestone === null ? null : (
          <Field label="Milestone">
            <ExternalLink
              className="hover:underline"
              href={summary.milestone.url}
            >
              {summary.milestone.title}
            </ExternalLink>
          </Field>
        )}
        {summary.labels.length === 0 ? null : (
          <Field label="Labels">
            {summary.labels.map((label) => (
              <Badge
                key={label.name}
                render={
                  <a
                    href={labelUrl(origin, ref, label.name)}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                style={labelColors(label.color)}
              >
                {label.name}
              </Badge>
            ))}
          </Field>
        )}
        {summary.assignees.length === 0 ? null : (
          <Field label="Assignees">
            {summary.assignees.map((assignee) => (
              <Person
                avatarUrl={assignee.avatarUrl}
                key={assignee.login}
                login={assignee.login}
                origin={origin}
              />
            ))}
          </Field>
        )}
      </dl>
    </aside>
  );
}
