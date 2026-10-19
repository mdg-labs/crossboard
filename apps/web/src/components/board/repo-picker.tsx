import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxValue,
} from "@/components/ui/combobox";
import { suggestQuery } from "@/lib/suggest";

/**
 * The repos a board is narrowed to (SPEC FR-34, D-21): a multi-select over the
 * repos the server suggests for what is typed. The server does the matching,
 * so the Combobox does not filter, and the picked repos stay in the list when
 * a search no longer returns them.
 */
export function RepoPicker({
  picked,
  onChange,
  disabled,
}: {
  picked: string[];
  onChange: (repos: string[]) => void;
  disabled: boolean;
}): React.ReactElement {
  const [search, setSearch] = useState("");
  const suggestions = useQuery({
    ...suggestQuery("repo", search),
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => {
    const lower = new Set(picked.map((repo) => repo.toLowerCase()));
    return [
      ...picked,
      ...(suggestions.data ?? []).filter(
        (repo) => !lower.has(repo.toLowerCase()),
      ),
    ];
  }, [picked, suggestions.data]);

  return (
    <Combobox
      disabled={disabled}
      filter={null}
      inputValue={search}
      items={items}
      multiple
      onInputValueChange={setSearch}
      onValueChange={(repos) => onChange(repos)}
      value={picked}
    >
      <ComboboxChips className="w-96">
        <ComboboxValue>
          {(repos: string[]) => (
            <Fragment>
              {repos.map((repo) => (
                <ComboboxChip aria-label={repo} key={repo}>
                  {repo}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label="Repositories"
                placeholder={repos.length === 0 ? "All repositories" : ""}
              />
            </Fragment>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxPopup>
        <ComboboxStatus>
          {suggestions.isPending
            ? "Loading repositories…"
            : suggestions.isError
              ? "Repositories are unavailable"
              : null}
        </ComboboxStatus>
        <ComboboxEmpty>
          {suggestions.isSuccess ? "No matching repositories" : null}
        </ComboboxEmpty>
        <ComboboxList>
          {(repo: string) => (
            <ComboboxItem key={repo} value={repo}>
              {repo}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
