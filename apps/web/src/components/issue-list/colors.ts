const GRAY = "#6e7781";

/** Primer colors for GitHub's issue-type color enum (SPEC §5.4). */
const TYPE_COLORS: Record<string, string> = {
  GRAY,
  BLUE: "#0969da",
  GREEN: "#1a7f37",
  YELLOW: "#9a6700",
  ORANGE: "#bc4c00",
  RED: "#d1242f",
  PINK: "#bf3989",
  PURPLE: "#8250df",
};

const HEX = /^[0-9a-f]{6}$/i;

function textColorOn(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = value >> 16;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 150
    ? "#1f2328"
    : "#ffffff";
}

export interface BadgeColors {
  backgroundColor: string;
  color: string;
}

function colorsFor(hex: string): BadgeColors {
  return { backgroundColor: hex, color: textColorOn(hex) };
}

/** An unknown or missing color renders as GRAY (SPEC §5.4). */
export function issueTypeColors(color: string | null): BadgeColors {
  const hex =
    color !== null && Object.hasOwn(TYPE_COLORS, color)
      ? TYPE_COLORS[color]
      : undefined;
  return colorsFor(hex ?? GRAY);
}

/** A label color is a hex string without `#` (SPEC §5.3). */
export function labelColors(color: string): BadgeColors {
  return colorsFor(HEX.test(color) ? `#${color}` : GRAY);
}
