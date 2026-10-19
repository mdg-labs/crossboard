import { useNavigate, useSearch } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list/issue-list";
import { DEFAULT_SORT, parseIndexSearch, type Sort } from "@/lib/issues";

export function IndexRoute(): React.ReactElement {
  const search = parseIndexSearch(useSearch({ strict: false }));
  const navigate = useNavigate();

  return (
    <IssueList
      onSortChange={(sort: Sort) =>
        void navigate({
          to: "/",
          search: {
            ...(search.q === undefined ? {} : { q: search.q }),
            ...(sort === DEFAULT_SORT ? {} : { sort }),
          },
        })
      }
      q={search.q ?? ""}
      sort={search.sort ?? DEFAULT_SORT}
    />
  );
}
