const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** "3 h ago" style text for a timestamp in milliseconds (SPEC §10). */
export function formatRelativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)} min ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)} h ago`;
  }
  if (elapsed < MONTH) {
    return `${Math.floor(elapsed / DAY)} d ago`;
  }
  if (elapsed < YEAR) {
    return `${Math.floor(elapsed / MONTH)} mo ago`;
  }
  return `${Math.floor(elapsed / YEAR)} y ago`;
}

/** The absolute time in the browser's time zone. */
export function formatAbsoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}
