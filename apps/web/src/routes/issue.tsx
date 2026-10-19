import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { IssueDetail } from "@/components/detail/issue-detail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import type { IssueRef } from "@/lib/issue-detail";

/** The detail of one issue as its own page, `/i/:owner/:repo/:number` (SPEC FR-39). */
export function IssueRoute(): React.ReactElement {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const number = Number(params.number);
  const issue: IssueRef | null =
    params.owner !== undefined &&
    params.repo !== undefined &&
    Number.isInteger(number) &&
    number > 0
      ? { owner: params.owner, repo: params.repo, number }
      : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <Link
        className={buttonVariants({
          className: "self-start",
          size: "sm",
          variant: "ghost",
        })}
        to="/"
      >
        <ArrowLeftIcon aria-hidden="true" />
        All issues
      </Link>
      {issue === null ? (
        <Alert variant="error">
          <AlertTitle>Not an issue</AlertTitle>
          <AlertDescription>
            <p>The address names no issue.</p>
          </AlertDescription>
        </Alert>
      ) : (
        <IssueDetail
          issue={issue}
          onOpenIssue={(next) =>
            void navigate({
              to: "/i/$owner/$repo/$number",
              params: {
                owner: next.owner,
                repo: next.repo,
                number: String(next.number),
              },
            })
          }
        />
      )}
    </div>
  );
}
