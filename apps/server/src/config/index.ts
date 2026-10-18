import { z } from "zod";

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface GithubAppCredentials {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
}

export interface Config {
  publicUrl: string;
  appSecret: string;
  allowedUsers: string[];
  allowedOrgs: string[];
  dataDir: string;
  webhooks: boolean;
  reconcileIntervalMin: number;
  port: number;
  logLevel: LogLevel;
  github: GithubAppCredentials | null;
  githubApiUrl: string;
  githubWebUrl: string;
}

export interface ConfigIssue {
  variable: string;
  problem: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues
        .map((issue) => `${issue.variable} ${issue.problem}`)
        .join("; ")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export type Env = Record<string, string | undefined>;

const GITHUB_APP_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

const isBlank = (value: unknown) =>
  typeof value === "string" && value.trim() === "";

const blankAsUnset = (value: unknown) => (isBlank(value) ? undefined : value);

const lowercase = (value: unknown) =>
  typeof value === "string" ? value.toLowerCase() : value;

const httpUrl = (problem: string) =>
  z.url({ protocol: /^https?$/, error: problem });

const integer = (min: number, max: number, problem: string) =>
  z
    .string({ error: problem })
    .regex(/^\d+$/, { error: problem })
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, { error: problem })
        .max(max, { error: problem }),
    );

const commaList = z.preprocess(
  blankAsUnset,
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ""),
    ),
);

const githubValue = z.preprocess(
  blankAsUnset,
  z.string({ error: "must be a string" }).optional(),
);

const schema = z.object({
  CROSSBOARD_PUBLIC_URL: z.preprocess(
    blankAsUnset,
    httpUrl("must be an http(s) URL"),
  ),
  CROSSBOARD_APP_SECRET: z.preprocess(
    blankAsUnset,
    z
      .string({ error: "is required" })
      .min(32, { error: "must be at least 32 characters" }),
  ),
  CROSSBOARD_ALLOWED_USERS: commaList,
  CROSSBOARD_ALLOWED_ORGS: commaList,
  CROSSBOARD_DATA_DIR: z.preprocess(blankAsUnset, z.string().default("/data")),
  CROSSBOARD_WEBHOOKS: z.preprocess(
    (value) => lowercase(blankAsUnset(value)),
    z
      .enum(["true", "false"], { error: "must be true or false" })
      .default("true")
      .transform((value) => value === "true"),
  ),
  CROSSBOARD_RECONCILE_INTERVAL_MIN: z.preprocess(
    blankAsUnset,
    integer(
      1,
      1440,
      "must be a whole number of minutes between 1 and 1440",
    ).optional(),
  ),
  PORT: z.preprocess(
    blankAsUnset,
    integer(1, 65535, "must be a port number between 1 and 65535").default(
      3000,
    ),
  ),
  LOG_LEVEL: z.preprocess(
    (value) => lowercase(blankAsUnset(value)),
    z
      .enum(LOG_LEVELS, {
        error: `must be one of ${LOG_LEVELS.join(", ")}`,
      })
      .default("info"),
  ),
  GITHUB_APP_ID: githubValue,
  GITHUB_APP_SLUG: githubValue,
  GITHUB_CLIENT_ID: githubValue,
  GITHUB_CLIENT_SECRET: githubValue,
  GITHUB_PRIVATE_KEY: githubValue,
  GITHUB_WEBHOOK_SECRET: githubValue,
  CROSSBOARD_GITHUB_API_URL: z.preprocess(
    blankAsUnset,
    httpUrl("must be an http(s) URL").default("https://api.github.com"),
  ),
  CROSSBOARD_GITHUB_WEB_URL: z.preprocess(
    blankAsUnset,
    httpUrl("must be an http(s) URL").default("https://github.com"),
  ),
});

export function loadConfig(env: Env = process.env): Config {
  const issues: ConfigIssue[] = [];

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        variable: String(issue.path[0] ?? "(configuration)"),
        problem: issue.message,
      });
    }
  }

  const missingGithub = GITHUB_APP_VARIABLES.filter(
    (name) => blankAsUnset(env[name]) === undefined,
  );
  if (
    missingGithub.length > 0 &&
    missingGithub.length < GITHUB_APP_VARIABLES.length
  ) {
    for (const variable of missingGithub) {
      issues.push({
        variable,
        problem:
          "is required because other GITHUB_* App credentials are set (all six or none)",
      });
    }
  }

  if (!parsed.success) {
    throw new ConfigError(issues);
  }
  const values = parsed.data;

  if (
    values.CROSSBOARD_ALLOWED_USERS.length === 0 &&
    values.CROSSBOARD_ALLOWED_ORGS.length === 0
  ) {
    issues.push({
      variable: "CROSSBOARD_ALLOWED_USERS, CROSSBOARD_ALLOWED_ORGS",
      problem: "must not both be empty",
    });
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const {
    GITHUB_APP_ID,
    GITHUB_APP_SLUG,
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    GITHUB_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET,
  } = values;
  const github =
    GITHUB_APP_ID !== undefined &&
    GITHUB_APP_SLUG !== undefined &&
    GITHUB_CLIENT_ID !== undefined &&
    GITHUB_CLIENT_SECRET !== undefined &&
    GITHUB_PRIVATE_KEY !== undefined &&
    GITHUB_WEBHOOK_SECRET !== undefined
      ? {
          appId: GITHUB_APP_ID,
          appSlug: GITHUB_APP_SLUG,
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          privateKey: GITHUB_PRIVATE_KEY,
          webhookSecret: GITHUB_WEBHOOK_SECRET,
        }
      : null;

  return {
    publicUrl: values.CROSSBOARD_PUBLIC_URL,
    appSecret: values.CROSSBOARD_APP_SECRET,
    allowedUsers: values.CROSSBOARD_ALLOWED_USERS,
    allowedOrgs: values.CROSSBOARD_ALLOWED_ORGS,
    dataDir: values.CROSSBOARD_DATA_DIR,
    webhooks: values.CROSSBOARD_WEBHOOKS,
    reconcileIntervalMin:
      values.CROSSBOARD_RECONCILE_INTERVAL_MIN ??
      (values.CROSSBOARD_WEBHOOKS ? 15 : 2),
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    github,
    githubApiUrl: values.CROSSBOARD_GITHUB_API_URL,
    githubWebUrl: values.CROSSBOARD_GITHUB_WEB_URL,
  };
}
