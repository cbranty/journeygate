# Deploying guard on Dokploy

One compose file, `deploy/docker-compose.dokploy.yml`, runs the whole stack on a Dokploy host: `guard serve` with the agent lane, Postgres, the S3 evidence store, the LiteLLM gateway and Redis. You select this repository, select that file, fill in the environment, add a domain and deploy. There is no override file and no profile.

Nothing in this file has been run on Dokploy or on any Docker engine. [What has not been verified](#what-has-not-been-verified) lists exactly what that leaves open.

## Before you start

| You need | Why |
| --- | --- |
| A dedicated Linux host managed by Dokploy | guard gets the Docker socket, which is root on the host. See [Security](#security-the-docker-socket). |
| An app repository with `target.toml` and `e2e-playwright/catalog/journeys.json` | `guard serve` refuses to start without them. They cannot come from the environment. |
| A code-host token that can clone that repository and push `agent/<KEY>` branches | The same token the stack already uses for the PR. |
| The sandbox image pushed to a registry, and its digest | The agent lane only accepts `<repo>@sha256:<64 hex>`. The `images` workflow prints it (`.github/workflows/images.yml`), or build it by hand (`sandbox/README.md`). The host's engine must have it or be able to pull it without credentials: a new GHCR package is private, so make it public, or run `docker login ghcr.io` and `docker pull <digest reference>` once on the host. |
| The host's docker group id | Run `getent group docker \| cut -d: -f3` on the host. |
| A DNS name for guard, and one that reaches the host on port 8333 | The first is the Dokploy domain. The second is `S3_PUBLIC_HOST`, for evidence links. They can be the same name. |

## Quick path

1. In Dokploy, create a **Compose** service of type **Docker Compose**. Do not choose Stack: this file builds images, and Dokploy's Stack mode does not support `build`.
2. **Provider**: select this repository (or your fork of it) and the branch to deploy.
3. **Compose Path**: `./deploy/docker-compose.dokploy.yml`.
4. **Environment**: paste `deploy/env.dokploy.example` and fill it in. Every variable has a one-line comment there. The required ones are in [Variables](#variables).
5. **Domains**: add a domain with service `guard`, container port `8080`, and HTTPS on.
6. **Deploy**. The first deploy compiles guard on the host (a Rust release build), so it takes minutes, not seconds.
7. Check the result:

   ```sh
   curl -fsS https://<your-domain>/healthz
   ```

   The logs of `repo-init` show the clone and which `agents.toml` and `thresholds.toml` were used. The startup line of `guard` lists what was wired.
8. Point the Jira webhook at `https://<your-domain>/webhooks/jira` with `GUARD_JIRA_WEBHOOK_SECRET` (`docs/contracts/server-api.md`, "Auth").

A wrong or missing variable fails the deploy at step 6 with a message that names the variable. guard does not start in that case.

## What cannot come from the environment

| Item | Where it comes from |
| --- | --- |
| `target.toml`, including `[areas]`, `[tracker]` and `[code_host]` | Committed at the root of the app repository (`docs/contracts/target-toml.md`). |
| The journeys catalog, `e2e-playwright/catalog/journeys.json` | Committed in the app repository. |
| `DOCKER_GID` | A fact of the host. You look it up there and set the variable; the stack cannot derive it. |
| The sandbox image digest, `GUARD_SANDBOX_IMAGE` | The digest a registry reports after a push. You set the variable; there is no default and no image is built at deploy time. |

`repo-init` checks the first two after the clone and stops the deploy when one is missing.

## Variables

`deploy/env.dokploy.example` is the complete list. These have no default:

| Variable | What to set |
| --- | --- |
| `GUARD_SERVER_TOKEN`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `REDIS_PASSWORD` | Secrets. Generate each with `openssl rand -hex 32`. Hex matters: three of them go into URLs unencoded. |
| `LITELLM_MASTER_KEY` | A secret that starts with `sk-`. LiteLLM requires that prefix. |
| `S3_PUBLIC_HOST` | The DNS name evidence readers use to reach this host. Not `localhost`. |
| `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, or `GITLAB_PROJECT` and `GITLAB_TOKEN` | The app repository and its token. |
| `DOCKER_GID` | The host's docker group id. |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | The credential for Claude models. When both are set, the subscription token is used (`docs/contracts/tokens.md`, "Anthropic credential"). |
| `GUARD_AGENT_MODEL`, `GUARD_AGENT_BUDGET_USD`, `GUARD_AGENT_DAILY_USD_CAP`, `GUARD_SANDBOX_IMAGE` | The agent lane, unless the app repository commits `agents.toml`. |
| `GUARD_THRESHOLDS_MODE` | `shadow` or `active`, unless the app repository commits `thresholds.toml`. Agents only start in `active`. |

### Which repository is cloned

| Code host | Clone URL |
| --- | --- |
| github.com | Derived from `GITHUB_REPOSITORY`: `https://github.com/<owner>/<name>.git`. |
| gitlab.com, with `GITLAB_PROJECT` as a path | Derived: `https://gitlab.com/<path>.git`. |
| GitHub Enterprise, self-managed GitLab, or `GITLAB_PROJECT` as a numeric id | Set `GUARD_APP_REPO_URL`. |

`GUARD_APP_REPO_URL` must be `https://` and must not contain credentials. With an explicit URL, `GITHUB_TOKEN` is used when set, otherwise `GITLAB_TOKEN`. `GUARD_APP_REPO_REF` selects a branch or tag; the default is the repository's default branch.

The token reaches git as an HTTP header through the environment, scoped to the clone URL. It is never in the URL, in a command line or in `.git/config`. This is the mechanism guard itself uses to push `agent/<KEY>`.

### How `agents.toml` and `thresholds.toml` are chosen

| The app repository has | guard reads |
| --- | --- |
| `agents.toml` | A copy of that file. The `GUARD_AGENT_*` variables and `GUARD_SANDBOX_IMAGE` are not read. |
| no `agents.toml` | One generated from those variables: two agents, `qa` and `coder`, on the gateway `http://litellm:4000`. |
| `thresholds.toml` | A copy of that file. `GUARD_THRESHOLDS_MODE` is not read. |
| no `thresholds.toml` | One generated with that mode. Every other threshold keeps its default. |

Generated files are written to the `guard-config` volume, never into the checkout. `guard agents check` validates the agents file before guard starts, and `guard serve` validates the thresholds file itself. The generated agents file sets only what those variables cover. For anything else, such as attempts, timeouts, rate limits or best-of-N, commit `agents.toml` (`docs/contracts/agents-toml.md`).

## What each deploy does

| Order | Service | What it does |
| --- | --- | --- |
| 1 | `volume-init` (root) | Gives the guard user (uid 10001) the checkout volume, the config volume and the agent work dir. The work dir is created on the host at `GUARD_AGENT_WORK_DIR`. |
| 2 | `repo-init` (uid 10001) | Clones the app repository, or updates the checkout that exists. Writes `agents.toml` and `thresholds.toml`. Runs `guard agents sync` when the repository has `agents/AGENTS.md`. |
| 3 | `guard` | Starts only after `repo-init` succeeds and Postgres, the evidence store and the gateway are healthy. |

On a later deploy `repo-init` fetches the checkout's branch and fast-forwards it. It never cleans or re-clones, and it never discards a local commit or a change to a tracked file, so `.guard/` and local `agent/<KEY>` branches survive. The one thing it replaces is an untracked file that the app repository now tracks, such as the output of `guard agents sync` once you commit it. When it cannot fetch or cannot fast-forward, it prints a warning, leaves the checkout as it is, and the deploy continues. guard itself never fetches, so a redeploy is how the checkout gets new commits.

`guard agents sync` also writes the developer files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.claude/skills/`) into the checkout. Commit them in the app repository, as `guard agents sync --check` expects. The next deploy replaces the untracked copies with the committed ones.

## Dokploy behavior this stack relies on

| Behavior | How the stack uses it | Source |
| --- | --- | --- |
| Dokploy writes the Environment tab to a `.env` file "in the same directory as your `docker-compose.yml`", here `deploy/.env`. The variables are not injected into containers by themselves. | Every value is read with `${NAME}` or passed through by name. No `env_file` is needed. | [Docker Compose](https://docs.dokploy.com/docs/core/docker-compose), "Environment" |
| A domain added in the Domains tab becomes Traefik labels on the selected service at deploy time. Without Isolated Deployments, Dokploy also adds `dokploy-network` to that service. | `guard` lists its networks explicitly, so it keeps reaching Postgres, the store and the gateway. Port 8080 is exposed, not published. | [Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains) |
| A domain change needs a redeploy. | Redeploy after adding or editing the domain. | [Domains](https://docs.dokploy.com/docs/core/domains) |
| Files of the repository must not be bind-mounted by relative path: Dokploy clones again on each deploy, and such mounts end up empty. | Nothing is mounted from this repository. The gateway config and the Postgres init script are built into images. | [Docker Compose](https://docs.dokploy.com/docs/core/docker-compose), "Volumes" |
| The docs recommend named volumes or `../files/...` for data, and say absolute host paths "will be cleaned up during deployments". | All data is in named volumes (`repo`, `guard-config`, `pg-data`, `s3-data`). Two absolute host paths remain, explained below. | Same page |

Two host paths are absolute on purpose:

- `/var/run/docker.sock`, the engine socket.
- `GUARD_AGENT_WORK_DIR`. The host engine resolves the sandboxes' bind mounts, so the directory must have the same absolute path on the host and in the guard container. A named volume or a `../files` path cannot give that. Its content is disposable: each attempt directory is removed when the attempt ends. To keep it inside the service's `files` folder anyway, set it to `/etc/dokploy/compose/<app name>/files/agent-work` (Dokploy's default location, from its source).

Do not add Dokploy **File Mounts** to this service. From Dokploy's source, not its documentation: with at least one File Mount, Dokploy passes `--project-directory` with the repository root, and the build contexts in this file are written relative to `deploy/`.

## Security: the Docker socket

A container that has `/var/run/docker.sock` controls the host's Docker engine, and that engine runs as root on the host. It can start privileged containers and mount any host path. Whoever compromises `guard serve`, for example through a leaked `GUARD_SERVER_TOKEN`, a webhook bug or a bad dependency, then controls the host, and with it every other application Dokploy runs there. The sandboxes are hardened (read-only, no capabilities, an internal network). The orchestrator that holds the socket is not.

- Use a dedicated host for this stack, never one shared with other Dokploy applications.
- Prefer rootless Docker, or gVisor with `GUARD_SANDBOX_RUNTIME=runsc`.
- Expose only the domain. Port 8080 is not published by this file.

Sandbox egress forwarders start on the `guard-gateway` network. Its name is fixed, so it does not depend on the project name Dokploy chooses. Only `litellm` and `guard` are attached to it, so a sandbox can reach the gateway but not Postgres or the evidence store. One host can therefore run one copy of this stack.

## Evidence links

guard signs every evidence link for the exact host in `GUARD_STORAGE_URL`, which this file builds as `S3_PUBLIC_HOST:8333`. The store publishes port 8333 on the host, and the same name resolves to the store inside the stack. Open port 8333 to the people and services that read evidence.

The links are plain HTTP. `https://trace.playwright.dev` loads traces from that address, and some browsers block an HTTPS page from fetching an HTTP resource. Serving the store over HTTPS through a second Dokploy domain is not wired in this file, because the signed host would change. `README.md` in this folder explains the constraint.

## Checklist

- [ ] The host is dedicated to this stack.
- [ ] The app repository has `target.toml` and the journeys catalog on the branch being cloned.
- [ ] `GUARD_SANDBOX_IMAGE` is a digest reference, and the host has the image or can pull it without credentials.
- [ ] `DOCKER_GID` matches `getent group docker` on the host.
- [ ] `LITELLM_MASTER_KEY` starts with `sk-`.
- [ ] `GUARD_THRESHOLDS_MODE` is `active` if agents should start.
- [ ] The domain points at the host, and port 8333 is reachable under `S3_PUBLIC_HOST`.
- [ ] `curl https://<your-domain>/healthz` answers 200.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The deploy fails with `set <NAME> in the Dokploy environment` | A required variable is empty. Set it and redeploy. |
| `repo-init` exits with `error: <NAME>: ...` | That variable is missing or invalid. The message says what it accepts. |
| `repo-init` exits with `cannot clone the app repository` | Check the repository variables and that the token can read the repository. |
| `repo-init` warns `cannot fast-forward` | The checkout has a local commit, or a tracked file was changed in it. To start clean, delete the `repo` volume; local `agent/<KEY>` branches that were not pushed are lost. |
| `litellm` exits with `CLAUDE_CODE_OAUTH_TOKEN must start with sk-ant-oat` | The value is not a Claude Code subscription token. An API key belongs in `ANTHROPIC_API_KEY`. |
| guard logs a permission error on the Docker socket | `DOCKER_GID` is not the host's docker group id. |
| The domain answers 502 or 504 | Redeploy after a domain change, and check that the domain's service is `guard` and its port `8080`. |

## What has not been verified

Docker is not installed on the machine where this was written, so none of the following has been run:

- `docker compose config`, `docker compose up` and the image builds, for any compose file in this folder.
- A deploy on Dokploy. The table above quotes its documentation as read on 2026-11-16. How Isolated Deployments interacts with this file's networks was not tested.
- That the first deploy's Rust build fits a small host. Its time and memory were not measured.
- `python3` as the gateway's health probe. LiteLLM's own compose file at this release uses it, and the image's base layers ship no `wget` applet; no container was started to confirm it.
- Whether Dokploy removes content under an absolute host path such as `GUARD_AGENT_WORK_DIR` during a deploy, as its documentation suggests.

What was verified without Docker: both compose files parse as YAML; every variable the Dokploy file reads is in `env.dokploy.example`; and the scripts under `deploy/dokploy/` pass their tests, which include a clone, an update and `guard agents check` on a generated `agents.toml`:

```sh
GUARD_BIN=<path to guard> node --test "deploy/dokploy/tests/*.test.mjs"
```

## Next step

With the stack up, move a ticket through the flow described in the repository `README.md`, and read `docs/contracts/tokens.md` before choosing between an API key and a Claude Code subscription.
