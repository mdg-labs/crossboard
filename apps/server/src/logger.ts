import { pino, type Logger } from "pino";
import type { LogLevel } from "./config/index.js";

const SENSITIVE_KEYS = [
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "secret",
  "clientSecret",
  "client_secret",
  "appSecret",
  "webhookSecret",
  "privateKey",
  "private_key",
  "password",
  "cookie",
  "set-cookie",
  "authorization",
];

const REDACT_DEPTH = 3;

const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const bracketed = `["${key}"]`;
  return Array.from({ length: REDACT_DEPTH }, (_, depth) => {
    const wildcards = Array<string>(depth).fill("*");
    return key.includes("-")
      ? [...wildcards, bracketed].join(".").replace(".[", "[")
      : [...wildcards, key].join(".");
  });
});

export function createLogger(
  level: LogLevel = "info",
  destination: { write(chunk: string): unknown } = process.stdout,
): Logger {
  return pino(
    {
      level,
      redact: { paths: redactPaths, censor: "[Redacted]" },
    },
    destination,
  );
}
