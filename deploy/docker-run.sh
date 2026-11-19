#!/bin/bash
# Recreate the pi-agent container on the super-agent image.
# Hardening matches the previous pi-agent deployment: non-root, zero caps, read-only
# rootfs, no published ports, outbound Feishu/GLM only.
set -euo pipefail
# Model routing lives in model.env so pi-model-guard can flip between glm-5.3 and deepseek-flash
# without editing this script.
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/model.env" ] && . "$HERE/model.env"
PI_PROVIDER=${PI_PROVIDER:-zhipu}
PI_MODEL=${PI_MODEL:-glm-5.3}
PI_API_BASE=${PI_API_BASE:-https://open.bigmodel.cn/api/coding/paas/v4}
PI_API_KEY_ENV=${PI_API_KEY_ENV:-ZHIPU_API_KEY}
docker rm -f pi-agent 2>/dev/null || true
# A2A: SUP_A2A / SUP_A2A_PORT / SUP_A2A_TOKEN / SUP_A2A_PUBLIC_URL / SUP_A2A_PEERS come from
# /etc/piagent.env; the port is published on the tailnet IP only.
docker run -d \
  --name pi-agent \
  --restart unless-stopped \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,size=512m \
  --env-file /etc/piagent.env \
  -p 100.68.159.13:18802:18802 \
  -e SUP_STATE_DIR=/workspace/.superagent \
  -e SUP_HARNESS_DIR=/workspace/.superagent/harness \
  -e SUP_WORK_DIR=/work \
  -e SUP_PROVIDER="$PI_PROVIDER" \
  -e SUP_MODEL="$PI_MODEL" \
  -e SUP_WORKER_PROVIDER="$PI_PROVIDER" \
  -e SUP_WORKER_MODEL="$PI_MODEL" \
  -e SUP_API_BASE="$PI_API_BASE" \
  -e SUP_API_KEY_ENV="$PI_API_KEY_ENV" \
  -e SUP_EVAL_MODE=auto \
  -e SUP_MAX_WORKERS=3 \
  --memory 4g --cpus 4 \
  --volume piagent-home:/home/piagent \
  --volume /data/piagent-workspace:/workspace \
  --volume /data/piagent-work:/work \
  --workdir /work \
  changediff/pi-agent:superagent-plugin5
echo "pi-agent started on changediff/pi-agent:superagent-plugin (hardened)."
# Rollback: rebuild the previous image tag changediff/pi-agent:superagent from git and repoint this
# script at it (it still exists until pruned).
