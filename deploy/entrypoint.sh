#!/bin/bash
# super-agent entrypoint: check secrets, prepare writable state, exec the runtime.
set -euo pipefail

: "${FEISHU_APP_ID:?FEISHU_APP_ID is required}"
: "${FEISHU_APP_SECRET:?FEISHU_APP_SECRET is required}"
: "${ZHIPU_API_KEY:?ZHIPU_API_KEY is required (GLM-5.3, coding endpoint)}"

export SUP_STATE_DIR="${SUP_STATE_DIR:-/workspace/.superagent}"
export SUP_HARNESS_DIR="${SUP_HARNESS_DIR:-$SUP_STATE_DIR/harness}"
export SUP_WORK_DIR="${SUP_WORK_DIR:-/work}"
export SUP_PROVIDER="${SUP_PROVIDER:-zhipu}"
export SUP_MODEL="${SUP_MODEL:-glm-5.3}"
export SUP_API_BASE="${SUP_API_BASE:-https://open.bigmodel.cn/api/coding/paas/v4}"
export SUP_EVAL_MODE="${SUP_EVAL_MODE:-auto}"
export FEISHU_DOMAIN="${FEISHU_DOMAIN:-feishu}"

mkdir -p "$SUP_STATE_DIR" "$SUP_HARNESS_DIR" "$SUP_WORK_DIR/superagent"
echo "[entry] super-agent starting (model=${SUP_PROVIDER}/${SUP_MODEL}, state=${SUP_STATE_DIR}, work=${SUP_WORK_DIR}, mode=${SUP_EVAL_MODE})"
exec node --experimental-transform-types --no-warnings /app/src/pi/main.ts
