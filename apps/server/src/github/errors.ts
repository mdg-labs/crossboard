export class GithubError extends Error {
  readonly status: number;
  /** GitHub's own message, without any request detail. */
  readonly githubMessage: string;

  constructor(status: number, githubMessage: string) {
    super(`GitHub responded ${String(status)}: ${githubMessage}`);
    this.name = "GithubError";
    this.status = status;
    this.githubMessage = githubMessage;
  }
}
