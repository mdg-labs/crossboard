---
description: Writing GitHub Actions workflows for MDG Labs repos — which runners, and what the self-hosted runners01 runners can and cannot do
paths:
  - ".github/**"
---

# GitHub Actions workflows

The runner a repo uses is `githubRunner` in `.claude/workflow.json`. **Public repos** run on GitHub-hosted runners (`ubuntu-latest`). **Private repos** run every job on the self-hosted runners on `runners01`: `runs-on: [self-hosted, runners01]`. A job asking only for `self-hosted` is never picked up, and `.github/actionlint.yaml` declares the `runners01` label for `actionlint`.

## What the runners01 runners are

Persistent GitHub Actions runners installed directly on the server `runners01`, defined in `mdg-labs/infra` (`inventory/runners/runners01.yaml`, `runbooks/ci-runners.md`):

- **Persistent, not ephemeral:** three runners, each a systemd service under its own Unix user with its own rootless Docker, in the private organization runner group `runners01`. Runners and their Docker daemons outlive a job, so a Docker image cache can survive between jobs; a cleanup hook removes the previous job's workspace and home. Never rely on anything surviving between jobs, and never leave anything behind.
- **Container jobs are the design:** every job runs in its own container (`container:`), and service containers (e.g. Postgres) work from a container job. The only exception is a job that needs the runner's rootless Docker daemon itself, such as an image build; it runs directly on the host and may use only the host baseline (below).
- **Docker is rootless and per runner:** a runner cannot reach another runner's daemon or the host's `/var/run/docker.sock`, and nothing runs privileged. Don't count on `--privileged`.
- **Limits:** each runner has 3 CPUs and 4.5 GB of memory (`CPUQuota=300%`, `MemoryMax=4500M`), shared by the runner, its Docker daemon and every job container. Tools that size themselves by the host's core count (vitest, turbo, `make -j$(nproc)`) see 8 cores: cap their workers in CI.
- **Host baseline:** the tools a job running directly on the host may rely on are listed in `mdg-labs/infra` `runbooks/ci-runners.md`, section "Host baseline" (infra#74). The list is modelled on the apt packages of GitHub's hosted Ubuntu image (`make`, `gcc`, `curl`, `jq`, `git`, `gh`, Docker CLI with `buildx` and `compose`, …) but is **not** the hosted image: no language toolchains, browsers, databases or development libraries, and no `sudo`. Read the list there; this rule does not copy it.
- **Unmeasured:** whether `--cap-add NET_ADMIN --device /dev/net/tun` works under rootless Docker has not been probed on these runners. Check it in a throwaway workflow before relying on it.

Pangolin tunnel from a container, measured 2026-10-08 on the previous runners; re-test on runners01 before relying on it:

- **A Pangolin tunnel works from a container:**
  - **Client:** the Pangolin CLI as a machine client (`pangolin up --attach --id … --secret … --endpoint …`) in a `debian:bookworm-slim` container started with `--cap-add NET_ADMIN --device /dev/net/tun` is `Connected` after about 15 s.
  - **DNS:** the client sets its container's resolver to Pangolin DNS (`100.96.128.1`). A second container on `--network container:<client>` therefore resolves Pangolin resource aliases with the normal system resolver; no `dig @100.96.128.1` workaround is needed.
  - **No direct path:** without the tunnel, the job doesn't reach services on other MDG Labs servers.
  - **Site side:** Newt must reach the target. Newt installed **on the host** cannot resolve container names, which only exist in Docker's DNS. Newt running **as a container on the service's Docker network** reaches `<container name>:<port>` with no host port mapped.

## Rules

- **Never assume a tool on the runner beyond the host baseline.** A job running directly on the host may use only what the host baseline lists. Language toolchains (Node, Python versions, Java, Go, …) come from a setup action (`actions/setup-node`, `pnpm/action-setup`, …), and anything else comes from a container or a setup action. On a GitHub-hosted runner the same workflow still works, since the baseline is a subset of the hosted image's packages.
- **A job that needs a toolbox runs in a container:** `container: node:22-bookworm` (or another image), then `apt-get install -y --no-install-recommends …` as root, with no sudo needed. Add `git config --global --add safe.directory "$GITHUB_WORKSPACE"` when the job runs git. `run:` steps in a container default to `sh`: set `defaults: run: shell: bash` when a script needs bash.
- **Service containers only work from a container job.** With `container:` set, reach the service by its name (`postgres:5432`). From a job running directly on the runner, neither the service nor any `docker run -p` port is reachable on `localhost`.
- **Never rely on the runner for network devices or host changes.** A VPN or WireGuard tunnel (e.g. Pangolin) runs in a container started with `--cap-add NET_ADMIN --device /dev/net/tun`, and the commands that need the tunnel run in that container's network (`--network container:<id>`).
- **Reaching a private service (e.g. a database for migrations)** goes through that tunnel shape. The secrets reach the containers only as `docker run -e NAME` from the job's env, never on a command line. Wait for `pangolin status` to show `Connected` before using the tunnel, and remove the client container in an `if: always()` step. Pangolin resources target `<container name>:<port>` through a containerised Newt on the server; never map a host port for this.
- **Install with pinned versions,** and prefer the distro's packages in a container to downloading archives on the runner.
- **On a GitHub-hosted public repo** none of the above applies, but a workflow that may later move to the self-hosted runners should still follow it.

## Running a workflow locally with act

A changed job is proven in the scratch clone with
`.claude/scripts/act-run.sh <checkout> <workflow file> <job id> [event]`, configured by `act` in `.claude/workflow.json`. Never call `act` directly, and never commit a `.actrc`: `act` applies `./.actrc` from the directory it starts in on top of its flags, so one could hand a job secrets. The script launches `act` outside the checkout with a minimal environment and an empty `HOME`, gives it no secrets, env, vars or inputs, refuses a job when it or anything it `needs` matches `act.neverRun`, reports PASS only when act says the job itself succeeded, and runs one `act` at a time per user.

What a local run is, measured with act 0.2.89 on 2026-10-17:

- **Not runners01.** The job runs on the local Docker daemon with the image `act.platforms` maps its `runs-on` label to: no rootless Docker, no 3 CPU / 4.5 GB limit, and an image that carries far more than the host baseline. A pass shows the steps work; it doesn't show the job fits on runners01.
- **Container jobs and services work:** a `container:` job with a Postgres service reached it as `pg`.
- **`act` copies `GITHUB_TOKEN` or `GH_TOKEN` from its own environment** into `secrets.GITHUB_TOKEN` and `github.token`. Hence the minimal environment: under the script both are empty.
- **`${{ secrets.X }}` is empty,** so a step that needs a secret, OIDC or the GitHub API fails, or does nothing, for that reason alone. What only a real run can show (a deploy, a release, a `schedule`, a production-branch-only trigger) is listed as *proves after landing*, never forced into a local run.
- **`-j <job>` also runs the jobs it `needs`.** Hence the check against `neverRun` covers act's whole plan, including a needed job the dry run skips: its `if:` may read outputs only a real run sets.
- **A job its `if:` skips exits 0.** The script reports it as unproven (exit 5), never as a pass.

## Testing runner behaviour

When you need to know how the runners behave — anything this rule doesn't answer, or something you suspect has changed — test it in a throwaway workflow in a private test repo on `[self-hosted, runners01]`, writing its findings to the step summary, never by trial and error in a product repo's workflows. Then record what you learned in this rule.
