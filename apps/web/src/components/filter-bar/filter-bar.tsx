import { parse } from "@crossboard/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  nameSuggestions,
  suggestionContext,
  valueSuggestions,
  type Suggestion,
} from "@/components/filter-bar/suggestions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
  AutocompletePrimitive,
  AutocompleteStatus,
} from "@/components/ui/autocomplete";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { parseIndexSearch } from "@/lib/issues";
import { suggestQuery } from "@/lib/suggest";

/**
 * The filter input of the top bar (SPEC FR-15 to FR-20). It validates what is
 * typed with the shared parser and only submits a valid filter, so the list
 * keeps showing the last valid result while the text has an error. It also
 * suggests qualifier names and, after a `:` or a comma, the values the server
 * knows for that qualifier.
 */
export function FilterBar(): React.ReactElement {
  const search = parseIndexSearch(useSearch({ strict: false }));
  const q = search.q ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const problems = useId();

  const [draft, setDraft] = useState(q);
  const [caret, setCaret] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [placeCaret, setPlaceCaret] = useState<{ at: number } | null>(null);
  const [reopen, setReopen] = useState<object | null>(null);
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

  const context = useMemo(
    () => suggestionContext(draft, caret ?? draft.length),
    [draft, caret],
  );
  const valueContext = context?.kind === "value" ? context : null;
  const values = useQuery({
    ...suggestQuery(valueContext?.field ?? "label", valueContext?.prefix ?? ""),
    enabled: valueContext !== null,
  });
  const suggestions: Suggestion[] = useMemo(() => {
    if (context === null) {
      return [];
    }
    return context.kind === "name"
      ? nameSuggestions(draft, context)
      : valueSuggestions(draft, context, values.data ?? []);
  }, [context, draft, values.data]);
  const popupOpen =
    open &&
    context !== null &&
    (valueContext !== null || suggestions.length > 0);
  const waiting = valueContext !== null && values.isPending;

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? null);
  const syncScroll = () => {
    setScrollLeft(inputRef.current?.scrollLeft ?? 0);
    syncCaret();
  };
  useLayoutEffect(syncScroll, [draft]);

  useLayoutEffect(() => {
    if (placeCaret !== null) {
      inputRef.current?.setSelectionRange(placeCaret.at, placeCaret.at);
      setCaret(placeCaret.at);
    }
  }, [placeCaret]);
  useEffect(() => {
    if (context === null) {
      setOpen(false);
    }
  }, [context]);
  // After this one on purpose: choosing a qualifier name leaves the old caret
  // in a commit without a context, and the popup must still open for its values.
  useEffect(() => {
    if (reopen !== null) {
      setOpen(true);
    }
  }, [reopen]);

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
      ref={formRef}
      className="relative col-start-2 row-start-1 w-full max-w-2xl justify-self-center"
      onSubmit={(event) => {
        event.preventDefault();
        setOpen(false);
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
      {/*
        The Autocomplete adds a hidden input to the form, and a form with two
        text inputs and no submit button is not submitted by Enter.
      */}
      <button hidden tabIndex={-1} type="submit" />
      <Autocomplete
        filter={null}
        itemToStringValue={(item: Suggestion) => item.text}
        items={suggestions}
        onOpenChange={setOpen}
        onValueChange={(value, details) => {
          // Escape and focus changes also report a value, but they must not
          // clear or rewrite what the user typed.
          if (details.reason === "input-change") {
            setDraft(value);
          } else if (details.reason === "item-press") {
            setDraft(value);
            const chosen = suggestions.find((item) => item.text === value);
            if (chosen !== undefined) {
              setPlaceCaret({ at: chosen.caret });
              if (chosen.continues) {
                setReopen({});
              }
            }
          }
        }}
        open={popupOpen}
        value={draft}
      >
        <InputGroup>
          <div className="relative isolate min-w-0 flex-1">
            <FilterErrorLayer
              error={error}
              scrollLeft={scrollLeft}
              text={draft}
            />
            <AutocompletePrimitive.Input
              aria-describedby={
                error !== null || warnings.length > 0 ? problems : undefined
              }
              aria-invalid={error !== null ? true : undefined}
              aria-label="Filter issues"
              autoComplete="off"
              onClick={syncCaret}
              onKeyUp={syncScroll}
              onScroll={syncScroll}
              onSelect={syncScroll}
              placeholder="Filter issues"
              ref={inputRef}
              render={<InputGroupInput nativeInput />}
              spellCheck={false}
              type="text"
            />
          </div>
          <InputGroupAddon align="inline-end">
            <Kbd aria-label="Press / to focus the filter">/</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <AutocompletePopup anchor={formRef}>
          <AutocompleteStatus>
            {waiting
              ? "Loading suggestions…"
              : values.isError
                ? "Suggestions are unavailable"
                : null}
          </AutocompleteStatus>
          <AutocompleteEmpty>
            {valueContext !== null && !waiting && !values.isError
              ? "No matching values"
              : null}
          </AutocompleteEmpty>
          <AutocompleteList>
            {(item: Suggestion) => (
              <AutocompleteItem key={item.text} value={item}>
                {item.label}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
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
