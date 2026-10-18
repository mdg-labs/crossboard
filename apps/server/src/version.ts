import { readFileSync } from "node:fs";
import { z } from "zod";

const manifest = z.object({ version: z.string().min(1) });

export function readServerVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return manifest.parse(JSON.parse(raw)).version;
}
