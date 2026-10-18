export const SENTINEL = "sentinel-secret-value-7f3a9c1e5d2b4a68";

export const validEnv = {
  CROSSBOARD_PUBLIC_URL: "https://crossboard.example.com",
  CROSSBOARD_APP_SECRET: "a".repeat(32),
  CROSSBOARD_ALLOWED_USERS: "octocat",
};

export const githubEnv = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "crossboard",
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: `client-${SENTINEL}`,
  GITHUB_PRIVATE_KEY: `key-${SENTINEL}`,
  GITHUB_WEBHOOK_SECRET: `hook-${SENTINEL}`,
};
