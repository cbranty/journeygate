# Installation: from an empty host to a first ticket handled

This guide installs guard for one flow: clients file Jira tickets, a team member moves a ticket to a start status, and agents open a draft pull request that a human approves. The stack runs on Dokploy from one compose file, `deploy/docker-compose.dokploy.yml`. Follow the phases in order. Each one ends with a check and the result you must see before you go on.

Examples use the Jira project `SHOP`, the start status `In Development`, the area `checkout` and GitHub as the code host. Replace them with your own values.

## Quick path

| Phase | You do | Done when |
| --- | --- | --- |
| [0. Prerequisites](#phase-0-prerequisites) | Collect accounts, a dedicated host with Docker and Dokploy, and two DNS names | `getent group docker` prints a group id on the host |
| [1. App repository](#phase-1-prepare-the-app-repository) | `guard init`, `[areas]`, `[tracker]` with `start_statuses`, `[code_host]`, the catalog; commit and push | `guard doctor` shows `0 errors` and both required files are pushed |
| [2. Jira](#phase-2-jira) | A dedicated API user and its token, the start status, the webhook and its secret | `GET /rest/api/3/myself` answers for the dedicated user |
| [3. Model credential](#phase-3-model-credential) | An Anthropic API key, or a Claude Code subscription token | You hold a key, or a token that starts with `sk-ant-oat` |
| [4. Images](#phase-4-images) | Run the `images` workflow and read the sandbox digest | The host pulls `ghcr.io/<owner>/guard-sandbox@sha256:<digest>` |
| [5. Dokploy](#phase-5-deploy-on-dokploy) | Service, compose path, environment, domain, deploy | `/healthz` answers, and the startup line says `agents active` |
| [6. First ticket](#phase-6-first-ticket) | Create a ticket, label its area when there is no engine, move it to the start status | A draft pull request on `agent/<KEY>` |
| [7. Day two](#phase-7-day-two-operations) | Redeploy, switch modes, rotate tokens, roll back | - |

## What each mode needs

Two choices shape the installation. Make them before phase 1.

### With or without the decision engine

| | With the engine (TypeSafe Jev) | Without the engine |
| --- | --- | --- |
| Variable | `TYPESAFE_API_KEY` (and `JEV_URL` when the service is not the default one) | None |
| Who picks the area of a ticket | The engine. In `active` mode guard writes the `area:<key>` label. | The team. The ticket needs an `area:<key>` label that names a key of `[areas]` before it is moved. guard never picks an area by itself. |
| A ticket moved to a start status | Decided by the hard rules, the sensitive areas and the thresholds on the engine's answers. | Decided by the hard rules, then the label: no usable label is the human lane with `no_area_label`; an area with `sensitive = true` is the human lane with `sensitive_area`; otherwise the agent lane. |
| A ticket that is only created | Triaged at creation. A ticket the gatekeeper sends to the agent lane starts there, before any move. | Recorded for the human lane with an engine error. Only the move to a start status reaches the agents. |
| Labels guard writes in `active` mode | `area:<key>`, `type:<kind>`, `lane:agent` or `lane:human`, and `flow-change` when it applies | Only `lane:agent` or `lane:human` |
| Startup line of `guard` | `engine jev` | `engine unavailable` |

### API key or Claude Code subscription

| | Anthropic API key | Claude Code subscription |
| --- | --- | --- |
| Variable | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN`, the output of `claude setup-token` |
| Billed to | The API account | The subscription |
| `GUARD_AGENT_BUDGET_USD` and `GUARD_AGENT_DAILY_USD_CAP` | Count the gateway's spend at API list prices | Count API list-price dollars, not money charged. They still stop an attempt or a day at the configured amount. |
| Other limit | - | The plan's own quota. When it is reached, Anthropic rejects the request and the attempt fails like any provider error. |
| Usage terms | - | Anthropic's terms for the plan are your responsibility. guard does not check them. |

When both variables are set, the subscription token is used. The credential stays in the gateway container; a sandbox holds only a per-attempt virtual key. Details: [`contracts/tokens.md`](contracts/tokens.md), "Anthropic credential".

## Required variables

This is the minimal set for the flow of this guide on GitHub. Each value goes into the Dokploy Environment tab in phase 5. The complete list, with every optional variable and the GitLab ones, is [`deploy/env.dokploy.example`](../deploy/env.dokploy.example); the rules for each are in [`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#variables).

| Variable | Value | Produced in |
| --- | --- | --- |
| `S3_PUBLIC_HOST` | The DNS name that reaches the host on port 8333. Not `localhost`. | Phase 0 |
| `DOCKER_GID` | The host's docker group id | Phase 0 |
| `GITHUB_REPOSITORY` | The app repository as `owner/name` | Phase 1 |
| `GITHUB_TOKEN` | A token that clones the app repository, pushes `agent/<KEY>` branches and opens pull requests | Phase 0 |
| `JIRA_BASE_URL` | The Jira site, for example `https://acme.atlassian.net` | Phase 2 |
| `JIRA_EMAIL` | The email of the dedicated Jira user | Phase 2 |
| `JIRA_API_TOKEN` | The API token of that user | Phase 2 |
| `GUARD_JIRA_WEBHOOK_SECRET` | `openssl rand -hex 32` | Phase 2 |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | The model credential | Phase 3 |
| `LITELLM_MASTER_KEY` | A secret that starts with `sk-` | Phase 3 |
| `GUARD_AGENT_MODEL` | A gateway model name, for example `claude-opus-5-5` | Phase 3 |
| `GUARD_AGENT_BUDGET_USD` | The USD budget of each agent attempt, for example `5` | Phase 3 |
| `GUARD_AGENT_DAILY_USD_CAP` | The USD spend per UTC day after which no new attempt starts, for example `50` | Phase 3 |
| `GUARD_SANDBOX_IMAGE` | `ghcr.io/<owner>/guard-sandbox@sha256:<64 hex>` | Phase 4 |
| `GUARD_SERVER_TOKEN`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `REDIS_PASSWORD` | `openssl rand -hex 32`, one each. Hex matters: three of them go into URLs unencoded. | Phase 5 |
| `GUARD_THRESHOLDS_MODE` | `active`. Agents never start in `shadow`. | Phase 5 |
| `GUARD_DASHBOARD_TOKEN` | `openssl rand -hex 32`. Without it the dashboard is open to anyone who reaches the domain. | Phase 5 |
| `TYPESAFE_API_KEY` | Only with the decision engine | Phase 0 |

`GUARD_AGENT_MODEL`, `GUARD_AGENT_BUDGET_USD`, `GUARD_AGENT_DAILY_USD_CAP` and `GUARD_SANDBOX_IMAGE` are not read when the app repository commits `agents.toml`. `GUARD_THRESHOLDS_MODE` is not read when it commits `thresholds.toml`.

Four things cannot come from the environment: `target.toml`, the journeys catalog, `DOCKER_GID` (a fact of the host) and the sandbox image digest (a fact of the registry).

---

## Phase 0: Prerequisites

| You need | Why |
| --- | --- |
| A Jira Cloud site where you administer the project and create a webhook | Jira Cloud is the only tracker. |
| A second Jira user for guard | guard ignores status and label changes made by its own Jira user, so the people who move tickets must be other users. |
| The app repository on GitHub (or GitLab), and a token for it | On GitHub the token needs `contents: write` and `pull_requests: write`, plus `issues: write` for labels. On GitLab it needs the `api` and `write_repository` scopes. |
| This repository, or your fork of it, on GitHub | Dokploy builds guard from it, and its `images` workflow publishes the sandbox image. |
| An Anthropic API key, or a Claude Code subscription | Phase 3. |
| A dedicated Linux host (amd64) with Docker and Dokploy | guard gets the Docker socket, which is control of the host. Never share the host with other Dokploy applications. One host runs one copy of this stack. See [`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#security-the-docker-socket). |
| Two DNS names that resolve to the host | One for guard: the Dokploy domain, called `<guard-domain>` below. One for evidence links, reached on port 8333: `S3_PUBLIC_HOST`. They can be the same name. |
| `guard` on your workstation | Phase 1 runs `guard init` in the app repository. |
| Optional: a TypeSafe Jev key | The decision engine. |

Install `guard` on the workstation:

```sh
curl -fsSL https://carlosbranty.github.io/journeygate/install.sh | sh
```

On the host, read the docker group id:

```sh
getent group docker | cut -d: -f3
```

**Check**

- `guard --version` prints a version on the workstation.
- The `getent` command prints a number on the host. It is `DOCKER_GID`.
- Both DNS names resolve to the host's address, and port 8333 is open to the people and services that read evidence.

## Phase 1: Prepare the app repository

`guard serve` reads `target.toml` and `e2e-playwright/catalog/journeys.json` from a checkout of the app repository, and refuses to start without them. The stack clones that checkout; these files have to be committed.

1. From the root of the app repository, let guard detect the app and write both files. Choose runner `guard`: the agent lane checks every candidate in a sandbox that starts the app with `[app].start`.

   ```sh
   guard init --runner guard
   ```

   That sandbox has no network egress and sets `PORT=3000` for the start command, then waits for `[app].ready_path` ([`contracts/qa-coder-protocol.md`](contracts/qa-coder-protocol.md), step 4). The walkthrough of `guard init`, the test-only routes and the journeys is [`getting-started.md`](getting-started.md), sections 2 and 4.

2. Edit `[areas]` in `target.toml`. Each key is what an `area:<key>` label names, and its `paths` are the only files the Coder agent writes for a ticket of that area. Set `sensitive = true` on an area that must always stay with humans.

   ```toml
   [areas.checkout]
   description = "Cart, payment and order confirmation"
   paths = ["web/src/checkout/**", "services/orders/**"]
   ```

3. Set `[tracker]` and `[code_host]`. `start_statuses` turns the status trigger on; absent or empty, it is off.

   ```toml
   [tracker]
   kind = "jira"
   project = "SHOP"
   ticket_pattern = 'SHOP-\d+'
   start_statuses = ["In Development"]

   [code_host]
   kind = "github"
   ```

   Each entry is a Jira status name. It is compared with the status of the ticket ignoring case and surrounding whitespace, so it must be the name the Jira workflow uses. Without `[code_host]` the agent lane builds the branch locally and opens no pull request.

4. Optional: `[hard_rules]`. `human_only_paths` and `max_fan_out_for_agent` send a ticket to the human lane whatever the label or the engine says ([`contracts/target-toml.md`](contracts/target-toml.md)).

5. Add at least one journey, so the gate has something to protect:

   ```sh
   guard new journey checkout.pay-card --title "Customer pays by card" --smoke
   ```

6. Optional: `agents/AGENTS.md`, the conventions the agents follow. When the repository has it, every deploy runs `guard agents sync`, which also writes `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.claude/skills/` into the checkout. Commit those files in the app repository.

7. Optional: commit `agents.toml` ([`contracts/agents-toml.md`](contracts/agents-toml.md)) or `thresholds.toml` ([`contracts/thresholds-toml.md`](contracts/thresholds-toml.md)). A committed file wins over the variables of phase 5. Commit `agents.toml` to set anything the variables do not cover: attempts, timeouts, rate limits or best-of-N.

8. Validate, commit and push to the branch the stack clones. That is the repository's default branch, or the branch or tag in `GUARD_APP_REPO_REF`.

   ```sh
   guard doctor
   git add target.toml e2e-playwright
   git commit -m "chore: add guard configuration"
   git push
   ```

**Check**

- `guard doctor` shows `0 errors`.
- `git ls-files target.toml e2e-playwright/catalog/journeys.json` prints both paths, and the commit is on the remote branch.

## Phase 2: Jira

1. **Project.** Its key is the value of `[tracker].project`, here `SHOP`.

2. **Dedicated user.** Create a Jira user for guard and an API token for it. Give it permission to read the project's issues, edit their labels, add comments and create issues (the gate files bugs with it). Its site, email and token are `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. guard reads its own account id from `GET /rest/api/3/myself` at startup and ignores every status and label change that user makes. A team member who works under the same account cannot start triage.

3. **Start status.** The workflow of the project has the status listed in `start_statuses`, with the same name: `In Development`.

4. **Secret.** Generate it and keep it for phase 5 as `GUARD_JIRA_WEBHOOK_SECRET`:

   ```sh
   openssl rand -hex 32
   ```

5. **Webhook.** Create a Jira webhook with these values:

   | Setting | Value |
   | --- | --- |
   | URL | `https://<guard-domain>/webhooks/jira?secret=<GUARD_JIRA_WEBHOOK_SECRET>` |
   | Events | Issue created and issue updated (`jira:issue_created`, `jira:issue_updated`) |
   | JQL filter | `project = SHOP` |

   Jira admin webhooks cannot set headers, so the secret goes in the query. A sender that sets headers, such as the Jira Automation "Send web request" action, sends `Authorization: Bearer <GUARD_JIRA_WEBHOOK_SECRET>` instead; the body must be the Jira Cloud webhook payload (`webhookEvent`, `user`, `issue`, `changelog`). guard triages every issue the webhook delivers and does not filter by project, so the JQL filter is what limits it to one project. The status move arrives as an issue updated event: without that event the trigger never fires.

6. Optional fields, both in [`deploy/env.dokploy.example`](../deploy/env.dokploy.example): `JIRA_SUGGESTED_FIELD`, a custom field for the Shadow Mode suggestion (without it the suggestion is a comment headed `jev-suggested`), and `JIRA_ACCEPTANCE_CRITERIA_FIELD`.

**Check**

Ask Jira who the token belongs to. guard makes the same call at startup.

```sh
curl -fsS -u '<JIRA_EMAIL>:<JIRA_API_TOKEN>' '<JIRA_BASE_URL>/rest/api/3/myself'
```

The answer is a JSON object whose `accountId` and `emailAddress` are the dedicated user's. The webhook itself is checked in phase 5, once the domain answers.

## Phase 3: Model credential

1. Get the credential.

   | You use | Do | Variable |
   | --- | --- | --- |
   | An API key | Create a key in the Anthropic account | `ANTHROPIC_API_KEY` |
   | A Claude Code subscription | Run `claude setup-token` on a machine logged in to that subscription and copy its output | `CLAUDE_CODE_OAUTH_TOKEN` |

   The gateway refuses to start when `CLAUDE_CODE_OAUTH_TOKEN` does not begin with `sk-ant-oat`, so an API key pasted into the wrong variable is never used silently. Set one variable. When both are set, the subscription token is used.

2. Choose the model. `GUARD_AGENT_MODEL` is a `model_name` of [`deploy/litellm/config.yaml`](../deploy/litellm/config.yaml). The default runtime, `claude-code`, accepts only Claude models: `claude-opus-5-5` or `anthropic/claude-sonnet-4-5`. The deploy does not compare the name with that file, so copy it exactly.

3. Choose the caps. `GUARD_AGENT_BUDGET_USD` is the budget of each agent attempt. `GUARD_AGENT_DAILY_USD_CAP` is the spend per UTC day after which no new attempt starts; running attempts finish. Under a subscription both count API list-price dollars.

4. Generate the gateway master key. LiteLLM requires the `sk-` prefix:

   ```sh
   echo "sk-$(openssl rand -hex 32)"
   ```

**Check**

- You hold exactly one credential: an API key for `ANTHROPIC_API_KEY`, or a token that starts with `sk-ant-oat` for `CLAUDE_CODE_OAUTH_TOKEN`.
- `LITELLM_MASTER_KEY` starts with `sk-`.
- `GUARD_AGENT_MODEL` is spelled as a `model_name` of `deploy/litellm/config.yaml`.

## Phase 4: Images

The agent lane accepts a sandbox image only as `<repo>@sha256:<64 hex>`. The `images` workflow ([`.github/workflows/images.yml`](../.github/workflows/images.yml)) builds it and pushes it to GHCR.

1. Run the workflow in this repository or your fork. It runs on every `v*` tag and on demand:

   ```sh
   gh workflow run images.yml
   ```

   It publishes two images, `ghcr.io/<owner>/guard-server` and `ghcr.io/<owner>/guard-sandbox`, for linux/amd64. A tag push publishes `<image>:<tag>`; a manual run publishes `<image>:sha-<commit>`. Nothing is tagged `latest`.

2. Read the digest. The job `publish (guard-sandbox)` prints `digest: ghcr.io/<owner>/guard-sandbox@sha256:<64 hex>`, and its summary has the line `Dokploy: GUARD_SANDBOX_IMAGE=<digest>`. That value is `GUARD_SANDBOX_IMAGE`.

3. Make the image available to the host. A new GHCR package starts private. Either make the `guard-sandbox` package public, or log in and pull it once on the host:

   ```sh
   docker login ghcr.io
   docker pull ghcr.io/<owner>/guard-sandbox@sha256:<64 hex>
   ```

The Dokploy stack takes only the sandbox image from the registry. It builds `guard serve` on the host from this repository at deploy time and does not pull the published `guard-server` image.

**Check**

On the host, `docker pull ghcr.io/<owner>/guard-sandbox@sha256:<64 hex>` completes without asking for credentials, or after the `docker login` above.

## Phase 5: Deploy on Dokploy

1. In Dokploy, create a **Compose** service of type **Docker Compose**. Do not choose Stack: the file builds images, and Stack mode does not support `build`.
2. **Provider**: this repository (or your fork) and the branch to deploy.
3. **Compose Path**: `./deploy/docker-compose.dokploy.yml`.
4. **Environment**: paste [`deploy/env.dokploy.example`](../deploy/env.dokploy.example) and fill in the values of [Required variables](#required-variables). Leave a variable empty to keep its default.
5. **Domains**: add a domain with service `guard`, container port `8080`, and HTTPS on.
6. **Deploy**. The first deploy compiles guard on the host (a Rust release build), so it takes minutes. Redeploy after any later change to the domain.

Do not add Dokploy File Mounts to the service ([`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#dokploy-behavior-this-stack-relies-on)).

To watch decisions before any agent runs, deploy first with `GUARD_THRESHOLDS_MODE=shadow`, complete phase 6 up to the decision, then [switch to `active`](#switch-between-shadow-and-active-mode).

A wrong or missing variable fails the deploy with a message that names the variable, and guard does not start.

**Check**

1. The server answers:

   ```sh
   curl -fsS https://<guard-domain>/healthz
   ```

   The JSON has `"status": "ok"`, and under `checks`: `"database": "ok"`, `"tracker": "configured"`, `"code_host": "configured"` and `"evidence": "configured"`. The `engine` entry is always `configured`; read the engine from the startup line below.

2. The logs of the `repo-init` service show the clone and end with `init: ready`. With no committed files they also show `agents.toml: generated (runtime claude-code, 1 host slot(s))` and `thresholds.toml: generated (mode active)`.

3. The logs of the `guard` service have the startup line. In `active` mode with a real code host it reads:

   ```text
   serve: listening on http://<address> (engine <jev or unavailable>, tracker jira, store postgres, code host github, evidence configured, agents active, memory postgres)
   agents: PRs: github draft PR
   ```

   `engine jev` means the decision engine is configured. `engine unavailable` means there is none, and the same log then has a warning that ends with `a move to a start status is decided on the hard rules and the ticket's area label`. That warning also confirms the checkout has `start_statuses`.

4. The webhook route accepts the secret. An event guard does not handle is answered without any effect:

   ```sh
   curl -sS -X POST -H 'Content-Type: application/json' \
     --data '{"webhookEvent":"comment_created"}' \
     'https://<guard-domain>/webhooks/jira?secret=<GUARD_JIRA_WEBHOOK_SECRET>'
   ```

   The answer is `{"accepted":false,"reason":"unsupported event comment_created"}`.

## Phase 6: First ticket

1. **Create the ticket** in the Jira project. Write the acceptance criteria as a list in the description: the agents receive the list items, or the whole description when it has no list.

2. **Without the decision engine, add the label** `area:<key>`, for example `area:checkout`. The key must exist in `[areas]`, and the area must not be sensitive. With the engine, skip this step.

3. **Move the ticket** to the start status, `In Development`, as a user other than guard's Jira user.

4. **Watch the decision.** Open `https://<guard-domain>/decisions` (with `GUARD_DASHBOARD_TOKEN` set, add `?token=<GUARD_DASHBOARD_TOKEN>` once). The ticket has a row.

   | Column | Expected in `active` mode | In `shadow` mode |
   | --- | --- | --- |
   | Mode | `active` | `shadow` |
   | Decided | `agent` | `agent` |
   | Applied | `agent` | `human (shadow_mode)`: the decision is recorded and suggested, and no agent starts |

   A human-lane decision shows its reasons in the same columns, for example `human (no_area_label)`. Without an engine the Area column shows `—`. In `active` mode the ticket also gets the label `lane:agent` in Jira.

   The page has no column for what started the decision or for the engine. Read them from Postgres, in the `postgres` container with `psql -U guard -d guard`:

   ```sql
   SELECT ticket_key, decided_at, decided_lane, decided_reasons,
          decision->>'trigger' AS trigger, decision->>'engine' AS engine
   FROM triage_decisions
   ORDER BY decided_at DESC
   LIMIT 5;
   ```

   For this ticket `trigger` is `status_change`, and `engine` is `used` or `not_configured`.

5. **Watch the agents.** The logs of the `guard` service print one line per stage, first for `qa`, then for `coder`:

   ```text
   agents: SHOP-7 qa -> ...
   agents: SHOP-7 coder -> ...
   ```

   A shell in the `guard` container lists the queue and the runs with `guard agents status --ticket SHOP-7`. The dashboard page `/agents` does not list runs.

6. **Open the pull request.** The code host has a draft pull request from branch `agent/SHOP-7` with the label `agent`. Its body starts with "**Agent PR for `SHOP-7`** (lane A). Human approval required: guard never merges agent PRs." and lists the sealed spec, the attempts and the cost.

**Check**

A draft pull request on `agent/<KEY>` exists in the app repository. A human reviews it, marks it ready and merges it; guard never does.

Facts that explain what you see on later tickets:

- With the engine, a ticket is triaged when it is created. In `active` mode, one the gatekeeper sends to the agent lane starts there, before any move.
- guard only adds labels. In `active` mode without an engine, a ticket gets `lane:human` when it is created and `lane:agent` when it is moved, and it keeps both. Each event is decided on its own; the move to the start status is what hands the ticket to the agents.
- A ticket being worked is not queued twice. Once its tasks have finished, a later move into a start status hands it off again.
- The server reads the ticket again before deciding. When its status is no longer a start status by then, nothing is recorded.

## Phase 7: Day-two operations

### Pick up new commits of the app repository

guard never fetches. Every deploy fetches the checkout's branch and fast-forwards it, so **redeploy** after a change to `target.toml`, the catalog, `agents/` or the app code the agents start from. The `repo-init` log line `init: the checkout is at <sha> (<branch>)` names the commit in use. The checkout keeps `.guard/` and local `agent/<KEY>` branches across deploys ([`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#what-each-deploy-does)).

### Switch between shadow and active mode

| The app repository | Do |
| --- | --- |
| Has no `thresholds.toml` | Set `GUARD_THRESHOLDS_MODE` to `shadow` or `active` in the Dokploy Environment and redeploy. |
| Commits `thresholds.toml` | Change `mode` in that file, push and redeploy. The variable is not read. |

In `shadow` every decision is recorded and suggested in Jira, and no agent starts. The startup line then says `agents disabled`. Setting `shadow` and redeploying is also how you stop new agent work.

### Turn the status trigger off

Remove `start_statuses` from `[tracker]` in `target.toml`, push and redeploy. A status change is then answered `200 {"accepted": false, ...}` and nothing else happens.

### Rotate a token

For the tokens of this flow, change the value in the Dokploy Environment and redeploy. Some have a second place to change:

| Variable | Also change |
| --- | --- |
| `GUARD_JIRA_WEBHOOK_SECRET` | The `secret` in the URL of the Jira webhook. Until both match, deliveries get `401`. |
| `JIRA_API_TOKEN` | Nothing. Create the new token for the dedicated user first. |
| `GITHUB_TOKEN` or `GITLAB_TOKEN` | Nothing. The same token clones the app repository and opens the pull requests, and it is never stored in the checkout. |
| `ANTHROPIC_API_KEY` | Nothing. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Nothing. Run `claude setup-token` again for the new value. |
| `GUARD_SERVER_TOKEN` | Every client that calls `/api/*`: the `GUARD_SERVER_TOKEN` of the CLI and of CI. |
| `GUARD_DASHBOARD_TOKEN` | Nothing. Open the dashboard with the new `?token=` once. |

`POSTGRES_PASSWORD` is not rotated by a redeploy: the Postgres image reads it only when it creates the `pg-data` volume.

### Roll back

| You want to | Do |
| --- | --- |
| Stop agents and keep recording decisions | Set `shadow` mode, as above. |
| Undo a change of the app repository | Revert the commit there, push and redeploy. |
| Run an earlier build of guard | Point the Dokploy service at a branch of this repository that holds the earlier build, and redeploy. |

Before running a build of guard that predates `[tracker].start_statuses`, check the decision log. Such a build cannot read a decision whose reason is `no_area_label`, so it cannot list the decisions of a database that holds one:

```sql
SELECT count(*) FROM triage_decisions WHERE 'no_area_label' = ANY (decided_reasons);
```

When the count is not `0`, stay on a build that has the status trigger and turn the trigger off in `target.toml` instead.

## Troubleshooting

Find the symptom you see. The second column is the first thing to check. Deploy-time failures of the stack itself have their own table in [`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#troubleshooting).

| Symptom | First thing to check |
| --- | --- |
| The deploy fails, or `repo-init` or `litellm` exits | The message names the variable or the missing file. Fix it and redeploy ([`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#troubleshooting)). |
| `repo-init` exits with `the app repository has no target.toml` or `... no e2e-playwright/catalog/journeys.json` | The file is not committed on the branch being cloned. Check `GUARD_APP_REPO_REF` and phase 1, step 8. |
| The sandbox image cannot be pulled on the host | The GHCR package is private. Make it public, or run `docker login ghcr.io` and pull the digest once on the host. |
| The Jira webhook gets `401` | The `secret` in the webhook URL is not the value of `GUARD_JIRA_WEBHOOK_SECRET`. |
| The Jira webhook gets `501` with `not_configured` | The startup line says `tracker disabled`. Either the checkout's `target.toml` has no `[tracker]`, or `JIRA_BASE_URL`, `JIRA_EMAIL` or `JIRA_API_TOKEN` is missing; the `guard` log then has a `warning: jira: ...` line. |
| Moving a ticket creates no row in `/decisions` | `start_statuses` in the checkout: the exact status name, committed, and deployed after the commit. Then that the webhook sends issue updated events, and that the person who moved the ticket is not guard's Jira user. |
| The `guard` log says `label changes are ignored until it answers` | guard cannot read `GET /rest/api/3/myself`, and until it does every status move is ignored. Check the three Jira variables with the `curl` of phase 2. |
| Decided is `human (no_area_label)` | The ticket has no `area:<key>` label whose key is in `[areas]`. Add it, then move the ticket out of the start status and back in. |
| Decided is `human (sensitive_area)` | The labelled area has `sensitive = true`. Sensitive areas always go to the human lane. |
| Decided is `human` with a hard rule (`hard_rule_path`, `schema_migration`, `fan_out_too_wide`) | `[hard_rules]` in `target.toml`. Hard rules are never overridden. |
| Decided is `human (engine_unavailable)` | The engine is configured and failed, or the impact analysis failed. Check `TYPESAFE_API_KEY` and `JEV_URL`. |
| Decided is `agent` and Applied is `human (shadow_mode)` | The mode is `shadow`. See [Switch between shadow and active mode](#switch-between-shadow-and-active-mode). |
| The decision is `agent` in `active` mode and no `agents:` line follows | The startup line. `agents disabled` comes with a warning that says why. |
| The agents finish and no pull request appears | The `guard` log line `agents: PRs: ...`. `local branch (<why>)` means the branch was built in the checkout and not pushed: fix `[code_host]`, `GITHUB_REPOSITORY` or `GITHUB_TOKEN`. |
| The push or the pull request is refused | The token's permissions: `contents: write`, `pull_requests: write` and `issues: write` on GitHub. |
| No new attempt starts | Today's spend reached `GUARD_AGENT_DAILY_USD_CAP`. It resets with the UTC day. |
| Attempts fail with provider errors under a subscription | The plan's usage limit. Anthropic rejects the request whatever the budget says. |
| A Claude Code feature fails behind the gateway | The `anthropic-beta` filter of the gateway ([`contracts/tokens.md`](contracts/tokens.md), "Limits of subscription mode"). |
| The agents work on old code | Redeploy. guard never fetches the app repository by itself. |
| Evidence links do not open | Port 8333 under `S3_PUBLIC_HOST`. The links are plain HTTP ([`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md#evidence-links)). |

## Next step

| To | Read |
| --- | --- |
| Tune thresholds, or leave Shadow Mode with calibration data | [`contracts/thresholds-toml.md`](contracts/thresholds-toml.md) and [`contracts/decision-log.md`](contracts/decision-log.md) |
| Configure attempts, timeouts, a second coder or best-of-N | [`contracts/agents-toml.md`](contracts/agents-toml.md) |
| Require the `guard` check on every pull request, agent pull requests included | [`getting-started.md`](getting-started.md), section 7 |
| Understand every webhook answer | [`contracts/server-api.md`](contracts/server-api.md), "Start on a status change" |
