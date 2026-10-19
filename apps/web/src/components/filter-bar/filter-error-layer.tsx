import type { QueryError } from "@crossboard/query";

/**
 * The text of the filter mirrored behind the input with the error range
 * underlined (SPEC FR-18, D-22). It only draws the underline: the text is
 * transparent, so the input's own text shows on top.
 */
export function FilterErrorLayer({
  text,
  error,
  scrollLeft,
}: {
  text: string;
  error: QueryError | null;
  /** The input's horizontal scroll, so the layer follows a long filter. */
  scrollLeft: number;
}): React.ReactElement | null {
  if (error === null) {
    return null;
  }
  const start = Math.min(Math.max(error.start, 0), text.length);
  const end = Math.min(Math.max(error.end, start + 1), text.length);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden whitespace-pre px-[calc(--spacing(3)-1px)] text-transparent leading-8.5 sm:leading-7.5"
      data-slot="filter-error-layer"
    >
      <span
        className="inline-block"
        style={{ transform: `translateX(${-scrollLeft}px)` }}
      >
        {text.slice(0, start)}
        <span
          className="underline decoration-destructive decoration-wavy underline-offset-4"
          data-error-range=""
        >
          {text.slice(start, end) || " "}
        </span>
        {text.slice(end)}
      </span>
    </div>
  );
}
