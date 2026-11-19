#!/bin/bash
# Seed the dispatch policy memory (docs/014-openviking-hub.md §Peer routing) into OpenViking:
# viking://user/<user>/memories/preferences/dispatch.md — written the way the openviking plugin's
# viking_write does it: mode=create first, falling back to mode=replace when the URI already exists.
#
# The API key comes from the environment (SUP_OPENVIKING_API_KEY, or OPENVIKING_API_KEY); nothing
# secret is stored in this repository, and the key is never printed.
#
# usage: SUP_OPENVIKING_API_KEY=<key> [SUP_OPENVIKING_ENDPOINT=<url>] \
#          [SUP_OPENVIKING_ACCOUNT=<account>] [SUP_OPENVIKING_USER=<user>] ./seed-dispatch-memory.sh
set -euo pipefail

API_KEY="${SUP_OPENVIKING_API_KEY:-${OPENVIKING_API_KEY:-}}"
ENDPOINT="${SUP_OPENVIKING_ENDPOINT:-https://api.vikingdb.cn-beijing.volces.com/openviking}"
ACCOUNT="${SUP_OPENVIKING_ACCOUNT:-default}"
USER="${SUP_OPENVIKING_USER:-default}"
URI="viking://user/${USER}/memories/preferences/dispatch.md"

usage() {
  echo "usage: SUP_OPENVIKING_API_KEY=<key> [SUP_OPENVIKING_ENDPOINT=<url>] [SUP_OPENVIKING_ACCOUNT=<account>] [SUP_OPENVIKING_USER=<user>] $0" >&2
  echo "  writes ${URI} via ${ENDPOINT}/api/v1/content/write (mode=create; replace when it already exists)" >&2
  echo "  the API key comes from SUP_OPENVIKING_API_KEY (fallback OPENVIKING_API_KEY); it is never stored or logged here" >&2
}

[ -n "$API_KEY" ] || { usage; exit 1; }

# The dispatch policy the superagent's worker brief also carries (§014): first choice per need,
# fallback, and the single-writer rule. This is the memory-owned copy the model reads at recall.
POLICY=$(cat <<'EOF'
# 派活规则（dispatch）

单对话编排的派活策略：先 peer_list 看谁在线，再用 peer_send 把整件事交给最合适的 agent。

| 需求 | 首选 | 备选 |
|---|---|---|
| 主机/编码/仓库/部署（cc2） | hermes-cc2 | superagent 自己做 |
| 记忆整理、调研、长文 | hermes-cc2 | cowagent-deb02 |
| deb02 与家庭实验室/新闻/盯盘 | cowagent-deb02 | hermes-cc2 |
| 已在进行中的工单 | 拥有该工单的 peer | — |

两个 peer 都不可用才自己做。派出去的任务要带上完整上下文，不要把半句话丢给对方。
做完把结果用 viking_write 记到 memories/events/；学到的持久偏好写 memories/preferences/。
superagent 是共享记忆根（viking://user/default/memories/**）的唯一写者；其他 agent 只写 peers/<id>/。
EOF
)

# JSON-escape the policy with POSIX tools only (no jq dependency): backslashes, quotes, newlines.
POLICY_JSON="\"$(printf '%s' "$POLICY" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}')\""

# One content write; prints "<body>\n<http_code>" so the caller can judge both.
write() { # $1 = mode (create | replace)
  local body
  body=$(printf '{"uri":"%s","content":%s,"mode":"%s","wait":true}' "$URI" "$POLICY_JSON" "$1")
  curl -sS -X POST "${ENDPOINT}/api/v1/content/write" \
    -H 'content-type: application/json' \
    -H "x-api-key: ${API_KEY}" \
    -H "authorization: Bearer ${API_KEY}" \
    -H "x-openviking-account: ${ACCOUNT}" \
    -H "x-openviking-user: ${USER}" \
    --data "${body}" \
    -w '\n%{http_code}'
}

# content_updated:true is the only outcome the server reports as a stored write.
stored() { [ "$1" = "200" ] && printf '%s' "$2" | grep -q '"content_updated"[[:space:]]*:[[:space:]]*true'; }

result=$(write create) || { echo "seed failed: request to ${ENDPOINT} failed" >&2; exit 1; }
http=${result##*$'\n'}
body=${result%$'\n'*}
if ! stored "$http" "$body"; then
  # mode=create refuses an existing URI: replace it instead, as viking_write's replace mode does.
  result=$(write replace) || { echo "seed failed: request to ${ENDPOINT} failed" >&2; exit 1; }
  http=${result##*$'\n'}
  body=${result%$'\n'*}
fi
if ! stored "$http" "$body"; then
  echo "seed failed: HTTP ${http}: ${body}" >&2
  exit 1
fi
echo "dispatch policy seeded at ${URI} (HTTP ${http})"
