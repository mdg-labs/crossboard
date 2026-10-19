import type { SuggestField } from "@/lib/suggest";

/** The qualifiers whose values the server suggests (SPEC FR-20). */
const VALUE_FIELDS: readonly SuggestField[] = [
  "label",
  "assignee",
  "author",
  "repo",
  "org",
  "user",
  "type",
  "milestone",
];

/** Every qualifier name of the filter language (SPEC §4.3). */
export const QUALIFIER_NAMES = [
  "assignee",
  "author",
  "blocked-by",
  "blocking",
  "has",
  "is",
  "label",
  "milestone",
  "no",
  "org",
  "parent",
  "repo",
  "type",
  "user",
] as const;

/** What the caret is on, and the part of the text a chosen suggestion replaces. */
export type SuggestionContext =
  | { kind: "name"; prefix: string; start: number; end: number }
  | {
      kind: "value";
      field: SuggestField;
      prefix: string;
      start: number;
      end: number;
    };

/** One entry of the popup: `text` is the whole filter after choosing it. */
export interface Suggestion {
  label: string;
  text: string;
  /** The caret position in `text` after choosing it. */
  caret: number;
  /** A qualifier name is followed by the suggestions for its values. */
  continues: boolean;
}

const QUALIFIER_HEAD = /^(-?)([A-Za-z][A-Za-z0-9-]*):/;
const NAME_PREFIX = /^-?([A-Za-z][A-Za-z0-9-]*)$/;

const isSpace = (char: string) => /\s/.test(char);

/** The end of the word that starts at `start`, as the filter lexer reads it. */
function wordEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const char = text.charAt(i);
    if (isSpace(char) || char === "(" || char === ")") {
      break;
    }
    if (char === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) {
        return text.length;
      }
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return i;
}

/** The end of the list element that starts at `start` inside a word ending at `end`. */
function elementEnd(text: string, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const char = text.charAt(i);
    if (char === ",") {
      break;
    }
    if (char === '"') {
      const close = text.indexOf('"', i + 1);
      i = close === -1 ? end : Math.min(close + 1, end);
    } else {
      i += 1;
    }
  }
  return i;
}

const isValueField = (name: string): name is SuggestField =>
  (VALUE_FIELDS as readonly string[]).includes(name);

/**
 * Where the caret is in the filter (SPEC FR-20): in a qualifier name being
 * typed, or in a value of a qualifier after its `:` or after a comma. The
 * value's prefix is the text between the last separator and the caret with
 * quotes removed. `null` when nothing is suggested there.
 */
export function suggestionContext(
  text: string,
  caret: number,
): SuggestionContext | null {
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (isSpace(char) || char === "(" || char === ")") {
      i += 1;
      continue;
    }
    const end = wordEnd(text, i);
    if (caret >= i && caret <= end) {
      return wordContext(text, i, end, caret);
    }
    i = end;
  }
  return null;
}

function wordContext(
  text: string,
  start: number,
  end: number,
  caret: number,
): SuggestionContext | null {
  const word = text.slice(start, end);
  const head = QUALIFIER_HEAD.exec(word);
  if (head === null) {
    const typed = text.slice(start, caret);
    const name = NAME_PREFIX.exec(typed);
    if (name === null || word.includes(":")) {
      return null;
    }
    return {
      kind: "name",
      prefix: name[1] as string,
      start: start + typed.length - (name[1] as string).length,
      end,
    };
  }
  const field = (head[2] as string).toLowerCase();
  const valuesStart = start + head[0].length;
  if (!isValueField(field) || caret < valuesStart) {
    return null;
  }
  let elementStart = valuesStart;
  for (;;) {
    const close = elementEnd(text, elementStart, end);
    if (caret <= close || close >= end) {
      return {
        kind: "value",
        field,
        prefix: text.slice(elementStart, caret).replaceAll('"', ""),
        start: elementStart,
        end: close,
      };
    }
    elementStart = close + 1;
  }
}

/** A value as the filter language reads it: quoted when it would otherwise split. */
export function formatValue(value: string): string {
  return /[\s,()]/.test(value) ? `"${value}"` : value;
}

function replaceRange(
  text: string,
  context: SuggestionContext,
  insert: string,
  continues: boolean,
  label: string,
): Suggestion {
  return {
    label,
    text: text.slice(0, context.start) + insert + text.slice(context.end),
    caret: context.start + insert.length,
    continues,
  };
}

/** The qualifier names that continue what is typed. */
export function nameSuggestions(
  text: string,
  context: Extract<SuggestionContext, { kind: "name" }>,
): Suggestion[] {
  const wanted = context.prefix.toLowerCase();
  return QUALIFIER_NAMES.filter((name) => name.startsWith(wanted)).map((name) =>
    replaceRange(text, context, `${name}:`, true, `${name}:`),
  );
}

/**
 * The server's values as choices. A value with a double quote cannot be
 * written in the filter language, so it is left out.
 */
export function valueSuggestions(
  text: string,
  context: Extract<SuggestionContext, { kind: "value" }>,
  values: readonly string[],
): Suggestion[] {
  return values
    .filter((value) => !value.includes('"'))
    .map((value) =>
      replaceRange(text, context, formatValue(value), false, value),
    );
}
