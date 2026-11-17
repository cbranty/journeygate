# dokploy-jira-agent-flow

Objective: deploy guard on Dokploy from one compose file configured by env vars, start the agent lane when a Jira ticket is moved to a configured status (Jev optional), and let the gateway bill a Claude Code subscription as well as an API key.
Branch: `feat/dokploy-jira-agent-flow` (base `e0c3454`). Delivery strategy: `ask-on-risk`; forecast above 400 authored lines, chain strategy not chosen yet, so no commit is made before the owner answers.
Test runners: `cargo test -p <crate>`, `node --test "schemas/*.test.mjs"`, `node --test "ci/tests/*.test.mjs"`.

## Specs

### S1 — One-step Dokploy deployment

User: "seleccionar el repo seleccionar el compose, determinar las variables de entorno, el dominio, y poner deploy y quede todo listo para probarse"

1. One compose file, `deploy/docker-compose.dokploy.yml`, runs the whole stack with no override file and no profile: guard, Postgres, the S3 evidence store and its init job, LiteLLM, Redis, and the agent-lane wiring that today lives in `deploy/docker-compose.agents.yml` (Docker socket, `group_add`, work dir, gateway network, `GUARD_GATEWAY_ADMIN_URL`, `GUARD_SANDBOX_EGRESS_NETWORK`).
2. An init step clones the app repository named by env vars into the checkout that guard serves at `/repo`, using the code-host token already required by the stack. The clone leaves no credential in `.git/config`. The checkout is writable by uid 10001. A second deploy with an existing checkout does not fail and does not discard `.guard/` state.
3. The init step renders the agent skills (`guard agents sync`) so `.guard/agents/rendered` exists before guard starts.
4. `GUARD_AGENT_WORK_DIR` exists at the same absolute path on the host and in the guard container, owned by uid 10001, without a manual host step.
5. The sandbox egress network has a fixed name that does not depend on the compose project name.
6. The guard HTTP port is reachable through a Dokploy domain. The evidence host stays configurable by env.
7. `deploy/docker-compose.yml` and `deploy/docker-compose.agents.yml` keep their current behavior, apart from S4.2.
8. `deploy/env.dokploy.example` lists every variable by name with a one-line comment, and a doc page gives the Dokploy steps in order and lists what can never come from env vars: `target.toml` (`[areas]`, `[tracker]`, `[code_host]`), the journeys catalog, `DOCKER_GID`, and the sandbox image digest.

### S2 — Agent and threshold configuration from env vars

User: "se pueda poner en el env tambien el modelo por defecto y demas"

1. When the checkout has no `agents.toml`, guard starts with one generated from env vars: default model, optional per-role model, runtime, per-agent budget, daily USD cap, host slots, sandbox image digest. An `agents.toml` committed in the checkout wins over the generated one.
2. When the checkout has no `thresholds.toml`, one is generated from an env var holding the mode (`shadow` or `active`). A committed file wins.
3. Generated files are accepted by the real parsers (`AgentsConfig::validate`, thresholds validation).
4. A missing or invalid value stops the container start with a message that names the variable. It never starts with a silently disabled agent lane because of a bad generated file.

### S3 — Start on a Jira status change, Jev optional

User: "creo en Jira un lo paso en desarrollo y jev detecta y un agente ne caso sea asi empiza a desarrollar"

1. `target.toml` accepts `[tracker].start_statuses`, a list of Jira status names. Absent or empty means the feature is off and every existing behavior is unchanged.
2. A `jira:issue_updated` webhook whose changelog moves the status to a name in that list (compared case-insensitively) starts triage for that ticket.
3. The event is ignored when the actor is guard's own Jira user, and when guard's account id is not known yet (fail closed), as label changes are today.
4. Before deciding, the server re-reads the issue and continues only when its current status is still in the list.
5. With a decision engine configured, the decision follows the same rules as `issue_created` triage today, including an engine failure going to the human lane with `EngineUnavailable`.
6. With no decision engine configured, the hard rules (human-only path, schema migration, fan-out) still apply. When none applies and the ticket carries an `area:<key>` label that exists in `[areas]`, the lane is agent. Without such a label the ticket goes to the human lane with a reason visible in the decision log. Assumption: no automatic choice of area.
7. Unchanged invariants: shadow mode never enqueues; a decision that was not recorded never reaches the agent lane; hard rules are never overridden; no label is written to Jira in shadow mode; `issue_created` and label-change handling behave exactly as before.
8. The decision log shows that the decision was started by a status change and whether an engine was used. The change is additive: no existing stored decision becomes unreadable and no destructive migration is added.
9. A re-delivered identical status event is handled once, like the other events.
10. Docs and schemas updated with the behavior: `docs/contracts/server-api.md`, `docs/contracts/target-toml.md`, `docs/contracts/decision-log.md`, `schemas/target.schema.json`, its example and its test, and the README tables that describe triage and the decision engine.

### S4 — Claude Code subscription at the gateway

User: "que no funcione solo con api si no tambien con claude code para que consuma eso en lugar del api"

1. The LiteLLM gateway can authenticate to Anthropic with a Claude Code subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, produced by `claude setup-token`) held only in the gateway's environment. The sandbox still holds only the virtual key. Runtime authentication in Rust is not changed.
2. The gateway image is pinned to the lowest stable LiteLLM release whose Anthropic adapter, for a configured key with the OAuth prefix, sends `Authorization: Bearer`, merges the OAuth value into the request's existing `anthropic-beta` values (it must not replace them) and drops `x-api-key`. The release is established from LiteLLM's source at release tags and recorded in the Log.
3. API-key mode keeps working unchanged. When both credentials are set, the subscription token is used.
4. Docs state: spend logs price subscription traffic at API list prices, so `budget_usd` and `daily_usd_cap` act as notional caps; the subscription's own quota applies; the path has not been run against live Anthropic; Anthropic's usage terms are the operator's responsibility.

### S5 — Published images

Accepted proposal item: "Publicación de la imagen del sandbox desde CI."

1. A workflow builds `deploy/sandbox/Dockerfile` and the `server` target of `deploy/Dockerfile`, pushes both to GHCR on `v*` tags and on manual dispatch, and prints each digest.
2. It follows the repository's workflow conventions: least permissions, and any third-party action pinned to a full commit SHA.
3. `release.yml` is unchanged.

## Tasks

- [x] T1 — S4 — delegated (deploy writer; parallel units and context backstop) — verified L12; commit `b51d62d`
- [x] T2 — S1, S2 — delegated (deploy writer) — verified L12, blocker fixed L13, recheck L15; commit `cb7b96e`
- [x] T3 — S5 — delegated (deploy writer) — verified L12 (static); commit: the one that adds `.github/workflows/images.yml` and this file
- [x] T4 — S3 — delegated (Rust writer; high-risk items 2 and 3, own commit, independent verifier) — verified L12; commit `b497c94`

Delivery: the owner chose four work-unit commits on this branch and a single pull request (L16). Slice boundaries: `b497c94` (S3), `cb7b96e` (S1, S2), `b51d62d` (S4), then the images commit (S5).

## Log

- L1 (2026-11-16, user, verbatim): "Hay manera para que la instalacion en dokploy sea sencillo?  por ejemplo seleccionar el repo seleccionar el compose, determinar las variables de entorno, el dominio, y poner deploy y quede todo listo para probarse, creo en Jira un lo paso en desarrollo y jev detecta y un agente ne caso sea asi empiza a desarrollar para ello en los env tambien se podria poner una cuenta de claude code por ejemplo para que lite llm pueda ejecutar los agentes y se pueda poner en el env tambien el modelo por defecto y demas"
- L2 (2026-11-16, user, verbatim): "que no funcione solo con api si no tambien con claude code para que consuma eso en lugar del api"
- L3 (2026-11-16, analysis): the `claude-code` runtime runs `claude -p --bare` with `apiKeyHelper = printenv <key_env>` and a gateway-pinned `ANTHROPIC_BASE_URL` (`guard-runtimes/src/claude_code.rs:92-130`); `--bare` does not read `CLAUDE_CODE_OAUTH_TOKEN`, and `GatewayEndpoint::pin` rejects `via_gateway = false` outside `copilot-cli`. The subscription token therefore enters at the gateway (S4), which also keeps spend logs and budgets working.
- L4 (2026-11-16, analysis): LiteLLM `main` has `optionally_handle_anthropic_oauth` with a branch on the configured `api_key` prefix, but no doc page describes it and the pinned image is `v1.77.7-stable`, older than the documented subscription support (`v1.81.14`). S4.2 exists because of this.
- L5 (2026-11-16, analysis): status changes arrive today as `TrackerEvent::Ignored` (`guard-tracker/src/webhook.rs:274`); without a Jev key `decide_without_engine` always returns human and no `area:` label is written, while `ticket_input` refuses tickets without one (`guard-cli/src/agent_lane/mod.rs:192`). S3.6 follows from this.
- L6 (2026-11-16, environment): Docker is not installed on the development machine. Compose files cannot be run or validated with `docker compose config` here, and no LiteLLM image can be started. These checks stay pending and must be reported as not run.
- L7 (2026-11-16, decision, parent): S4.2 rewritten from "lowest release" to "lowest stable release that merges `anthropic-beta`". Reason: the sandboxed client is the real Claude Code CLI and sends its own `anthropic-beta` values; `v1.81.12-stable` through `v1.82.0-stable` replace the header, `v1.82.3-stable` merges it (`_merge_beta_headers` in `litellm/llms/anthropic/common_utils.py`, both the client-header and the configured-key branch); `v1.82.1-stable` and `v1.82.2-stable` do not exist (HTTP 404). Confirmed at `v1.82.3-stable`: `docker/prod_entrypoint.sh`, `ENTRYPOINT`, `WORKDIR /app`, the upstream compose health probe (`python3` on `/health/liveliness`) and the GHCR manifest (HTTP 200). Pin applied inline by the parent after the writer's correction run died on a network error.
- L8 (2026-11-16, progress): T1-T3 written by the deploy writer; T4 by the Rust writer. Parent inline edits outside the writers' surfaces: `guard-store/tests/common/fixtures.rs` (two new `TriageDecision` fields, test fixture only) and one step in `.github/workflows/ci.yml` running `node --test "deploy/dokploy/tests/*.test.mjs"`.
- L9 (2026-11-16, decisions taken by the writers, not settled by the specs): engine presence is detected with a new `DecisionEngine::is_configured()` because `EngineError::Unconfigured` is also returned by a configured Jev for area-count problems; without an engine a `sensitive = true` area and a failed impact analysis both go to the human lane; a changelog carrying both labels and a listed status counts as a status change; dedupe uses the status plus `changelog.id`; `issue_created` decisions also record `trigger` and `engine`; required env vars with no default are `GUARD_AGENT_MODEL`, `GUARD_AGENT_BUDGET_USD`, `GUARD_AGENT_DAILY_USD_CAP`, `GUARD_SANDBOX_IMAGE`, `GUARD_THRESHOLDS_MODE`; the Dokploy file builds the gateway config and the Postgres init script into images instead of bind-mounting repository files; the LiteLLM health probe uses `python3`.
- L10 (2026-11-16, known gaps): in active mode a ticket triaged at creation and again on a status move can carry both `lane:human` and `lane:agent`, because the tracker port only adds labels; the dashboard `/decisions` page has no trigger or engine column.
- L12 (2026-11-16, independent verification): verdict per item was `met` for S1.1, S1.3-S1.8, S2.1-S2.4, S3.1-S3.10, S4.1, S4.2, S4.4, S5.1-S5.3 (compose, Dockerfile and workflow items static only), `not verifiable here` for S4.3 beyond the entry-script tests, and one blocker on S1.2: once the app repository commits the files `guard agents sync` writes, the untracked copies in the checkout made every later fast-forward fail, so the checkout stopped updating. With the features off, baseline and candidate were byte-identical across 13 webhook cases and 5 pages in three configurations. LiteLLM `v1.82.3-stable` trace: `clean_headers` strips the incoming virtual key from both headers, then the configured token is applied; the virtual key cannot reach Anthropic or shadow the token.
- L13 (2026-11-16, correction, parent inline): `deploy/dokploy/init.sh` `update()` now moves to the fetched commit with `git reset --hard` when the fast-forward is refused, HEAD is an ancestor of the fetched commit and no tracked file differs from HEAD; any other refusal keeps the previous warning. RED observed first ("a file guard wrote here that the repository starts tracking does not block a later deploy" failed on the old script), then GREEN: `GUARD_BIN=<baseline> node --test "deploy/dokploy/tests/*.test.mjs"` 118 passed. `deploy/DOKPLOY.md` and `docs/contracts/tokens.md` corrected to match (the latter now states that LiteLLM filters `anthropic-beta` through its own list after merging). Recheck of this blocker requested from the verifier.
- L15 (2026-11-16, recheck of the S1.2 blocker by the verifier): fixed. With the real `guard agents sync` output committed upstream, the second deploy printed "replaced untracked files that the app repository now tracks" and reached the upstream commit; a later `target.toml` change arrived by plain fast-forward. `.guard/`, ignored files, an unrelated untracked file and a local `agent/SHOP-1` branch in a linked worktree survived. A local commit, an uncommitted tracked edit, a tracked edit plus an untracked collision, and a staged-only file plus an untracked collision each left the checkout untouched with the warning. The only thing the reset replaces is an untracked file at a path the fetched commit tracks; the log line does not name the replaced files (optional improvement, not done). Next step: the owner chooses how the work is committed and sliced.
- L16 (2026-11-16, user, verbatim, answering "four commits on this branch and one pull request at the end" versus chained pull requests): "de la manera 1". Commits made in the order status trigger, Dokploy stack, subscription, images. The subscription commit follows the Dokploy one because its tests read both compose stacks. Each of the two deploy commits was tested from a snapshot of the index before committing: Dokploy stack 101 passed (with `GUARD_BIN`), `ci/tests` 45 passed and 3 skipped; subscription 114 passed and 4 skipped (no `GUARD_BIN`). Receipt-driven development is off at global scope, so no native review ran. Not pushed; no pull request opened.
- L14 (2026-11-16, advisories left open, for the owner): a decision with the new `no_area_label` reason makes a baseline binary unable to list decisions from the same database (rollback hazard); a changelog with both a listed status and labels records no human label; `GUARD_AGENT_BUDGET_USD=05` is caught by `guard agents check` rather than by the generator; a daily cap below the per-agent budget and a Claude model name missing from `deploy/litellm/config.yaml` pass every check; `GUARD_AGENT_WORK_DIR` is not validated, so a value such as `/etc` would be chowned to uid 10001 by the root init container; with `GUARD_APP_REPO_URL` set, the code-host token is sent to whatever host that URL names; `images.yml` leaves `persist-credentials` at its default.
- L11 (2026-11-16, checks observed by the parent): `cargo fmt --all -- --check` exit 0; `cargo test --workspace --no-fail-fast` 1946 passed, 3 failed, 79 ignored, the 3 failures being `guard-sandbox --test quality_node` (`a_clean_spec_passes`, `a_missing_script_is_a_quality_error`, `focus_sleep_and_self_mock_are_reported_with_stable_ids`), which need `guard-sandbox/assets/node_modules` and were reported by the writer as failing identically on the base export; `cargo test -p guard-store` 131 passed after the fixture edit; `node --test "schemas/*.test.mjs"` 57 passed; `node --test "ci/tests/*.test.mjs"` 55 passed, 3 skipped; `GUARD_BIN=<baseline> node --test "deploy/dokploy/tests/*.test.mjs"` 116 passed. Not run: `cargo clippy --workspace --all-targets -- -D warnings` cannot pass here (system Rust 1.99.1 instead of the pinned 1.88.0; the writer reported the same 53 errors on the base export), anything needing Docker, a live LiteLLM, live Anthropic, Jira or a Dokploy host.
