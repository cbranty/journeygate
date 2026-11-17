#!/bin/sh
# Writes the agents.toml and thresholds.toml that guard serve reads in the
# Dokploy stack (deploy/docker-compose.dokploy.yml):
#
#   render-config.sh <checkout> <out-dir>
#
# For each file: when the checkout commits one, it is copied to <out-dir>
# unchanged and the variables below are not read. Otherwise the file is
# generated from the environment:
#
#   agents.toml      GUARD_AGENT_MODEL          required, model of both roles
#                    GUARD_AGENT_QA_MODEL       optional, model of the QA agent
#                    GUARD_AGENT_CODER_MODEL    optional, model of the Coder agent
#                    GUARD_AGENT_RUNTIME        default claude-code
#                    GUARD_AGENT_BUDGET_USD     required, budget of each agent
#                    GUARD_AGENT_DAILY_USD_CAP  required
#                    GUARD_AGENT_HOST_SLOTS     default 1
#                    GUARD_SANDBOX_IMAGE        required, <repo>@sha256:<64 hex>
#   thresholds.toml  GUARD_THRESHOLDS_MODE      required, shadow or active
#
# A missing or invalid value is an error that names the variable (exit 2).
# Every problem is reported in one run, and nothing is written unless all
# values are valid. Values are never echoed back.
#
# The rules mirror docs/contracts/agents-toml.md and
# docs/contracts/thresholds-toml.md. `guard agents check` stays the authority:
# deploy/dokploy/init.sh runs it on the result.
set -eu

# The gateway of the Dokploy stack: the litellm service and its master key.
GATEWAY_URL="http://litellm:4000"
GATEWAY_MASTER_KEY_ENV="LITELLM_MASTER_KEY"

if [ "$#" -ne 2 ]; then
  echo "usage: render-config.sh <checkout> <out-dir>" >&2
  exit 2
fi
checkout=$1
out=$2

errors=0
fail() {
  printf 'error: %s: %s\n' "$1" "$2" >&2
  errors=$((errors + 1))
}

newline='
'

# value NAME: prints the variable's value; an empty value counts as unset.
value() {
  eval "printf '%s' \"\${$1:-}\""
}

# matches VALUE ERE: true when the single-line VALUE matches the whole ERE.
matches() {
  case $1 in *"$newline"*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq "^($2)\$"
}

# positive_number VALUE: a plain decimal greater than zero.
positive_number() {
  matches "$1" '[0-9]+(\.[0-9]+)?' || return 1
  case $(printf '%s' "$1" | tr -d '0.') in '') return 1 ;; esac
}

# toml_float VALUE: the decimal with a fractional part, as TOML floats need.
toml_float() {
  case $1 in
    *.*) printf '%s' "$1" ;;
    *) printf '%s.0' "$1" ;;
  esac
}

# check_model NAME: the gateway model name in NAME, when it is set.
check_model() {
  model=$(value "$1")
  [ -n "$model" ] || return 0
  if ! matches "$model" '[A-Za-z0-9][A-Za-z0-9._:/@-]*'; then
    fail "$1" "must be a gateway model name (letters, digits and . _ : / @ -)"
  elif [ "$runtime_ok" = 1 ] && [ "$runtime" = claude-code ]; then
    # agents-toml.md: claude-code accepts only Claude models.
    case ${model##*/} in
      claude*) ;;
      *) fail "$1" "must be a Claude model because GUARD_AGENT_RUNTIME is claude-code" ;;
    esac
  fi
}

# ---- agents.toml ---------------------------------------------------------------
agents_source=committed
if [ ! -f "$checkout/agents.toml" ]; then
  agents_source=generated

  runtime=$(value GUARD_AGENT_RUNTIME)
  runtime=${runtime:-claude-code}
  runtime_ok=1
  case $runtime in
    claude-code | codex | copilot-cli | mini-swe-agent | openhands) ;;
    *)
      runtime_ok=0
      fail GUARD_AGENT_RUNTIME "must be one of claude-code, codex, copilot-cli, mini-swe-agent, openhands"
      ;;
  esac

  default_model=$(value GUARD_AGENT_MODEL)
  if [ -z "$default_model" ]; then
    fail GUARD_AGENT_MODEL "is required: the gateway model both agents use (set it, or commit agents.toml in the app repository)"
  fi
  check_model GUARD_AGENT_MODEL
  check_model GUARD_AGENT_QA_MODEL
  check_model GUARD_AGENT_CODER_MODEL
  qa_model=$(value GUARD_AGENT_QA_MODEL)
  qa_model=${qa_model:-$default_model}
  coder_model=$(value GUARD_AGENT_CODER_MODEL)
  coder_model=${coder_model:-$default_model}

  budget=$(value GUARD_AGENT_BUDGET_USD)
  if [ -z "$budget" ]; then
    fail GUARD_AGENT_BUDGET_USD "is required: the USD budget of each agent attempt"
  elif ! positive_number "$budget"; then
    fail GUARD_AGENT_BUDGET_USD "must be a number greater than 0, such as 5 or 2.50"
  fi

  daily_cap=$(value GUARD_AGENT_DAILY_USD_CAP)
  if [ -z "$daily_cap" ]; then
    fail GUARD_AGENT_DAILY_USD_CAP "is required: the USD spend per UTC day after which no attempt starts"
  elif ! positive_number "$daily_cap"; then
    fail GUARD_AGENT_DAILY_USD_CAP "must be a number greater than 0, such as 50"
  fi

  host_slots=$(value GUARD_AGENT_HOST_SLOTS)
  host_slots=${host_slots:-1}
  if ! matches "$host_slots" '[1-9][0-9]{0,8}'; then
    fail GUARD_AGENT_HOST_SLOTS "must be a whole number of concurrent sandboxes, 1 or more"
  fi

  image=$(value GUARD_SANDBOX_IMAGE)
  if [ -z "$image" ]; then
    fail GUARD_SANDBOX_IMAGE "is required: the sandbox image pinned by digest (<repo>@sha256:<64 hex>)"
  elif ! matches "$image" '[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}'; then
    fail GUARD_SANDBOX_IMAGE "must be pinned by digest: <repo>@sha256:<64 lowercase hex>"
  fi
fi

# ---- thresholds.toml -----------------------------------------------------------
thresholds_source=committed
if [ ! -f "$checkout/thresholds.toml" ]; then
  thresholds_source=generated

  mode=$(value GUARD_THRESHOLDS_MODE)
  case $mode in
    shadow | active) ;;
    '') fail GUARD_THRESHOLDS_MODE "is required: shadow or active (set it, or commit thresholds.toml in the app repository)" ;;
    *) fail GUARD_THRESHOLDS_MODE "must be shadow or active" ;;
  esac
fi

if [ "$errors" -gt 0 ]; then
  exit 2
fi

# ---- write -----------------------------------------------------------------------
# Each file is written next to its destination and renamed, so a reader never
# sees half a file.
mkdir -p "$out"
tmp_agents="$out/.agents.toml.$$"
tmp_thresholds="$out/.thresholds.toml.$$"
trap 'rm -f "$tmp_agents" "$tmp_thresholds"' EXIT

if [ "$agents_source" = committed ]; then
  cp "$checkout/agents.toml" "$tmp_agents"
  echo "agents.toml: using the one committed in the checkout"
else
  cat > "$tmp_agents" <<EOF
# Generated by deploy/dokploy/render-config.sh from the GUARD_AGENT_* and
# GUARD_SANDBOX_IMAGE variables. Do not edit: it is rewritten on every deploy.
# An agents.toml committed in the app repository replaces it.
version = 1

[gateway]
url = "$GATEWAY_URL"
master_key_env = "$GATEWAY_MASTER_KEY_ENV"

[roles]
qa = "qa"
coder = "coder"

[agents.qa]
role = "qa"
runtime = "$runtime"
model = "$qa_model"
budget_usd = $(toml_float "$budget")

[agents.coder]
role = "coder"
runtime = "$runtime"
model = "$coder_model"
budget_usd = $(toml_float "$budget")

[scheduler]
host_slots = $host_slots
daily_usd_cap = $(toml_float "$daily_cap")
image = "$image"
EOF
  echo "agents.toml: generated (runtime $runtime, $host_slots host slot(s))"
fi

if [ "$thresholds_source" = committed ]; then
  cp "$checkout/thresholds.toml" "$tmp_thresholds"
  echo "thresholds.toml: using the one committed in the checkout"
else
  cat > "$tmp_thresholds" <<EOF
# Generated by deploy/dokploy/render-config.sh from GUARD_THRESHOLDS_MODE.
# Do not edit: it is rewritten on every deploy. A thresholds.toml committed in
# the app repository replaces it. Every other threshold keeps its default.
version = 1
mode = "$mode"
EOF
  echo "thresholds.toml: generated (mode $mode)"
fi

chmod 0644 "$tmp_agents" "$tmp_thresholds"
mv -f "$tmp_agents" "$out/agents.toml"
mv -f "$tmp_thresholds" "$out/thresholds.toml"
