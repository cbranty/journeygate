#!/bin/sh
# One-shot init of the Dokploy stack (deploy/docker-compose.dokploy.yml,
# service repo-init). It runs as the guard user before guard serve starts:
#
#   1. Clones the app repository into the checkout, or fast-forwards the
#      checkout that is already there. Nothing is ever reset or cleaned, so
#      .guard/ and the agent/<KEY> branches survive every deploy.
#   2. Checks that the repository has what guard serve cannot start without.
#   3. Writes agents.toml and thresholds.toml (render-config.sh) and has guard
#      validate the agents file.
#   4. Renders the agent skills (guard agents sync).
#
# Repository:   GUARD_APP_REPO_URL  clone URL (https://). Optional on github.com
#                                   and gitlab.com, where it is derived from
#                                   GITHUB_REPOSITORY or GITLAB_PROJECT.
#               GUARD_APP_REPO_REF  branch or tag; default: the default branch.
# Credential:   GITHUB_TOKEN or GITLAB_TOKEN, the token the stack already
#               needs. It reaches git as an HTTP header through the
#               environment, scoped to the clone URL: it is never in argv, in
#               the URL or in .git/config.
#
# Exit status: 0 ready; 2 a variable or the repository content is wrong (the
# message names it); 1 an operation failed. A warning never fails the deploy.
set -eu

checkout=${GUARD_INIT_CHECKOUT:-/repo}
config=${GUARD_INIT_CONFIG_DIR:-/config}
guard=${GUARD_BIN:-guard}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

log() { printf 'init: %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
# die STATUS MESSAGE
die() {
  status=$1
  shift
  printf 'error: %s\n' "$*" >&2
  exit "$status"
}

newline='
'
tab=$(printf '\t')

# Git never prompts and never asks a credential helper: the header is all.
export GIT_TERMINAL_PROMPT=0

# ---- which repository, with which credential ------------------------------------
url=${GUARD_APP_REPO_URL:-}
ref=${GUARD_APP_REPO_REF:-}
token_user=
token=

if [ -n "$url" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    token_user=x-access-token
    token=$GITHUB_TOKEN
  elif [ -n "${GITLAB_TOKEN:-}" ]; then
    token_user=oauth2
    token=$GITLAB_TOKEN
  fi
else
  github_api=${GITHUB_API_URL:-}
  gitlab_api=${GITLAB_API_URL:-}
  if [ -n "${GITHUB_REPOSITORY:-}" ] && { [ -z "$github_api" ] || [ "${github_api%/}" = https://api.github.com ]; }; then
    url="https://github.com/${GITHUB_REPOSITORY}.git"
    token_user=x-access-token
    token=${GITHUB_TOKEN:-}
  elif [ -n "${GITLAB_PROJECT:-}" ] && { [ -z "$gitlab_api" ] || [ "${gitlab_api%/}" = https://gitlab.com/api/v4 ]; }; then
    case $GITLAB_PROJECT in
      */*)
        url="https://gitlab.com/${GITLAB_PROJECT}.git"
        token_user=oauth2
        token=${GITLAB_TOKEN:-}
        ;;
    esac
  fi
  if [ -z "$url" ]; then
    die 2 "GUARD_APP_REPO_URL: is required: the https clone URL of the app repository. It is derived only from GITHUB_REPOSITORY on github.com or from a GITLAB_PROJECT path on gitlab.com"
  fi
fi

# The value is never echoed: a refused URL may hold a token.
bad_url() { die 2 "GUARD_APP_REPO_URL: $*"; }
case $url in
  *"$newline"* | *" "* | *"$tab"* | -*) bad_url "is not a clone URL" ;;
esac
authority=${url#*://}
authority=${authority%%/*}
case $url in
  https://* | http://* | file://*) ;;
  *) bad_url "must be an https:// URL (ssh remotes are not supported: the stack holds a token, not a key)" ;;
esac
case $authority in
  *@*) bad_url "must not embed credentials: set GITHUB_TOKEN or GITLAB_TOKEN instead" ;;
esac
case $url in
  http://*)
    # Cleartext http would send the token unencrypted: loopback only.
    case $authority in
      localhost | localhost:* | 127.0.0.1 | 127.0.0.1:* | '[::1]' | '[::1]:'*) ;;
      *) bad_url "must be https (the token would travel unencrypted over http)" ;;
    esac
    ;;
esac
if [ -n "$ref" ]; then
  case $ref in *"$newline"*) ref_ok=0 ;; *) ref_ok=1 ;; esac
  if [ "$ref_ok" = 0 ] || ! printf '%s\n' "$ref" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'; then
    die 2 "GUARD_APP_REPO_REF: must be a branch or tag name"
  fi
fi

# git_remote ARGS...: git with the token as a header for $url only.
git_remote() {
  if [ -n "$token" ]; then
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.$url.extraHeader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $(printf '%s:%s' "$token_user" "$token" | base64 | tr -d '\n')" \
      git -c credential.helper= "$@"
  else
    git -c credential.helper= "$@"
  fi
}

# ---- 1. the checkout --------------------------------------------------------------
clone() {
  # Cloned next to its destination and moved in when complete, so an
  # interrupted clone never leaves a half checkout, and whatever the
  # directory already holds (.guard/) stays.
  staging="$checkout/.guard-init-clone"
  rm -rf "$staging"
  set -- clone --quiet --no-checkout
  if [ -n "$ref" ]; then
    set -- "$@" --branch "$ref"
  fi
  if ! git_remote "$@" -- "$url" "$staging"; then
    rm -rf "$staging"
    die 1 "cannot clone the app repository: check GUARD_APP_REPO_URL, GUARD_APP_REPO_REF and the code-host token"
  fi
  mv "$staging/.git" "$checkout/.git"
  rmdir "$staging"
  git -C "$checkout" reset --quiet --hard
  log "cloned the app repository at $(git -C "$checkout" rev-parse --short HEAD)"
}

update() {
  at=$(git -C "$checkout" rev-parse --short HEAD 2>/dev/null) || at=unknown
  branch=$(git -C "$checkout" symbolic-ref --quiet --short HEAD) || branch=
  if [ -z "$branch" ]; then
    log "the checkout is on a tag or a detached commit ($at): left unchanged"
    return 0
  fi
  if [ "$(git -C "$checkout" config --local --get remote.origin.url || true)" != "$url" ]; then
    warn "GUARD_APP_REPO_URL is not the origin of the existing checkout: left unchanged at $at. Delete the checkout volume to clone another repository"
    return 0
  fi
  if [ -n "$ref" ] && [ "$ref" != "$branch" ]; then
    warn "GUARD_APP_REPO_REF is not the branch the existing checkout is on ($branch): left unchanged at $at. Delete the checkout volume to clone another branch"
    return 0
  fi
  if ! git_remote -C "$checkout" fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch"; then
    warn "cannot fetch $branch from the app repository: the checkout stays at $at"
    return 0
  fi
  if ! refused=$(git -C "$checkout" merge --quiet --ff-only "origin/$branch" 2>&1); then
    # `guard agents sync` (step 4) writes files into the checkout. Once the
    # app repository commits them, the untracked copies here block the
    # fast-forward on every later deploy. When the checkout has no local
    # commit and no change to a tracked file, moving to the fetched commit
    # loses nothing but those untracked copies, which the repository now
    # provides. Other untracked and ignored files (.guard/) are not touched.
    if git -C "$checkout" merge-base --is-ancestor HEAD "origin/$branch" \
      && git -C "$checkout" diff --quiet HEAD -- \
      && git -C "$checkout" reset --quiet --hard "origin/$branch"; then
      log "replaced untracked files that the app repository now tracks"
    else
      [ -z "$refused" ] || printf '%s\n' "$refused" >&2
      warn "cannot fast-forward $branch to the app repository: the checkout stays at $at. It has local commits or changed files in the way"
      return 0
    fi
  fi
  log "the checkout is at $(git -C "$checkout" rev-parse --short HEAD) ($branch)"
}

if [ ! -d "$checkout" ] || [ ! -w "$checkout" ]; then
  die 1 "the checkout directory $checkout is missing or not writable by uid $(id -u)"
fi
if [ -d "$checkout/.git" ]; then
  update
else
  clone
fi

# ---- 2. what cannot come from the environment --------------------------------------
for required in target.toml e2e-playwright/catalog/journeys.json; do
  if [ ! -f "$checkout/$required" ]; then
    die 2 "the app repository has no $required: guard serve cannot start without it, and it cannot come from the environment (deploy/DOKPLOY.md)"
  fi
done

# ---- 3. agents.toml and thresholds.toml --------------------------------------------
sh "$here/render-config.sh" "$checkout" "$config" || exit $?
export GUARD_AGENTS_TOML="$config/agents.toml"
if ! (cd "$checkout" && "$guard" agents check); then
  die 2 "guard agents check rejected agents.toml (committed in the app repository, or generated from the GUARD_AGENT_* and GUARD_SANDBOX_IMAGE variables)"
fi

# ---- 4. the agent skills ----------------------------------------------------------
if [ -f "$checkout/agents/AGENTS.md" ]; then
  if ! (cd "$checkout" && "$guard" agents sync); then
    die 1 "guard agents sync failed: fix agents/ in the app repository"
  fi
else
  log "the app repository has no agents/AGENTS.md: no agent skills to render"
fi

log "ready"
