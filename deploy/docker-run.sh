#!/bin/bash
# Recreate the pi-agent container on the super-agent image.
# Hardening matches the previous pi-agent deployment: non-root, zero caps, read-only
# rootfs, no published ports, outbound Feishu/GLM only.
set -euo pipefail
docker rm -f pi-agent 2>/dev/null || true
docker run -d \
  --name pi-agent \
  --restart unless-stopped \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,size=512m \
  --env-file /etc/piagent.env \
  -e SUP_STATE_DIR=/workspace/.superagent \
  -e SUP_HARNESS_DIR=/workspace/.superagent/harness \
  -e SUP_WORK_DIR=/work \
  -e SUP_PROVIDER=zhipu \
  -e SUP_MODEL=glm-5.3 \
  -e SUP_API_BASE=https://open.bigmodel.cn/api/coding/paas/v4 \
  -e SUP_EVAL_MODE=auto \
  -e SUP_MAX_WORKERS=3 \
  --memory 4g --cpus 4 \
  --volume piagent-home:/home/piagent \
  --volume /data/piagent-workspace:/workspace \
  --volume /data/piagent-work:/work \
  --workdir /work \
  changediff/pi-agent:superagent
echo "pi-agent started on changediff/pi-agent:superagent (hardened)."
