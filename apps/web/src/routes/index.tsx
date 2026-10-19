import { useNavigate, useSearch } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list/issue-list";
import { appendQualifier } from "@/components/filter-bar/qualifiers";
import { DEFAULT_SORT, parseIndexSearch, type Sort } from "@/lib/issues";

export function IndexRoute(): React.ReactElement {
  const search = parseIndexSearch(useSearch({ strict: false }));
  const navigate = useNavigate();

  return (
    <IssueList
      onFilter={(qualifier) => {
        const q = appendQualifier(search.q ?? "", qualifier);
        if (q === null) {
          return;
        }
        void navigate({
          to: "/",
          search: {
            q,
            ...(search.sort === undefined ? {} : { sort: search.sort }),
            ...(search.nest === undefined ? {} : { nest: search.nest }),
          },
        });
      }}
      onNestChange={(nest) =>
        void navigate({
          to: "/",
          search: {
            ...(search.q === undefined ? {} : { q: search.q }),
            ...(search.sort === undefined ? {} : { sort: search.sort }),
            nest: nest ? (1 as const) : undefined,
          },
        })
      }
      onSortChange={(sort: Sort) =>
        void navigate({
          to: "/",
          search: {
            ...(search.q === undefined ? {} : { q: search.q }),
            ...(sort === DEFAULT_SORT ? {} : { sort }),
            ...(search.nest === undefined ? {} : { nest: search.nest }),
          },
        })
      }
      nest={search.nest === 1}
      q={search.q ?? ""}
      sort={search.sort ?? DEFAULT_SORT}
    />
  );
}
