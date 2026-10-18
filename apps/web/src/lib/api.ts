import type { AppType } from "@crossboard/server";
import { hc } from "hono/client";

export const api = hc<AppType>("/");
