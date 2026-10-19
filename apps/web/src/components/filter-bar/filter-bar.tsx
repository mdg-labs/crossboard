import { parse } from "@crossboard/query";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FilterErrorLayer } from "@/components/filter-bar/filter-error-layer";
import { isShortcut } from "@/components/filter-bar/keyboard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { parseIndexSearch } from "@/lib/issues";

/**
 * The filter input of the top bar (SPEC FR-15 to FR-19). It validates what is
 * typed with the shared parser and only submits a valid filter, so the list
 * keeps showing the last valid result while the text has an error.
 */
export function FilterBar(): React.ReactElement {
  const search = parseIndexSearch(useSearch({ strict: false }));
  const q = search.q ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const problems = useId();

  const [draft, setDraft] = useState(q);
  const [shownQuery, setShownQuery] = useState(q);
  const [scrollLeft, setScrollLeft] = useState(0);
  if (shownQuery !== q) {
    setShownQuery(q);
    setDraft(q);
  }

  const parsed = useMemo(
    () => (draft.trim() === "" ? null : parse(draft)),
    [draft],
  );
  const error = parsed !== null && "error" in parsed ? parsed.error : null;
  const warnings =
    parsed !== null && "warnings" in parsed ? parsed.warnings : [];

  const syncScroll = () => setScrollLeft(inputRef.current?.scrollLeft ?? 0);
  useLayoutEffect(syncScroll, [draft]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && isShortcut(event)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form
      className="relative col-start-2 row-start-1 w-full max-w-2xl justify-self-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (error !== null) {
          return;
        }
        const next = draft.trim();
        void navigate({
          to: "/",
          search: {
            ...(next === "" ? {} : { q: next }),
            ...(search.sort === undefined ? {} : { sort: search.sort }),
          },
        });
        if (next === q) {
          void queryClient.invalidateQueries({ queryKey: ["issues"] });
        }
      }}
      role="search"
    >
      <InputGroup>
        <div className="relative isolate min-w-0 flex-1">
          <FilterErrorLayer
            error={error}
            scrollLeft={scrollLeft}
            text={draft}
          />
          <InputGroupInput
            aria-describedby={
              error !== null || warnings.length > 0 ? problems : undefined
            }
            aria-invalid={error !== null ? true : undefined}
            aria-label="Filter issues"
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyUp={syncScroll}
            onScroll={syncScroll}
            onSelect={syncScroll}
            placeholder="Filter issues"
            ref={inputRef}
            spellCheck={false}
            type="text"
            value={draft}
          />
        </div>
        <InputGroupAddon align="inline-end">
          <Kbd aria-label="Press / to focus the filter">/</Kbd>
        </InputGroupAddon>
      </InputGroup>
      {error !== null || warnings.length > 0 ? (
        <div
          className="absolute inset-x-0 top-full z-30 mt-1 flex flex-col gap-1 rounded-xl bg-background"
          id={problems}
        >
          {error !== null ? (
            <Alert variant="error">
              <AlertTitle>Invalid filter</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          {warnings.map((warning) => (
            <Alert
              key={`${warning.start}-${warning.end}-${warning.message}`}
              role="status"
              variant="warning"
            >
              <AlertDescription>{warning.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      ) : null}
    </form>
  );
}
