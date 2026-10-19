const OWN_KEYS =
  "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=listbox], [role=menu], [role=dialog]";

/**
 * Whether a keydown is meant for the list's shortcuts: no modifier, not
 * already handled, and not typed into a field or an open popup.
 */
export function isShortcut(event: KeyboardEvent): boolean {
  return !(
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (event.target instanceof Element && event.target.closest(OWN_KEYS) !== null)
  );
}
