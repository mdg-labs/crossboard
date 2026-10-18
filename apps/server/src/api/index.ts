import { Hono } from "hono";

export function createApi(options: { version: string }) {
  return new Hono().get("/health", (c) =>
    c.json({ status: "ok" as const, version: options.version }),
  );
}
