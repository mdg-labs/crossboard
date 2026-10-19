export class GithubError extends Error {
  readonly status: number;
  /** GitHub's own message, without any request detail. */
  readonly githubMessage: string;
  /** The `error` code of a GitHub OAuth failure, such as `bad_refresh_token`. */
  readonly code?: string;

  constructor(status: number, githubMessage: string, code?: string) {
    super(`GitHub responded ${String(status)}: ${githubMessage}`);
    this.name = "GithubError";
    this.status = status;
    this.githubMessage = githubMessage;
    if (code !== undefined) this.code = code;
  }
}
