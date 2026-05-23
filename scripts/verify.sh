#!/usr/bin/env bash
# GeminiClaw 连通性验证脚本
# 用法: bash scripts/verify.sh [session_id]

HOST="127.0.0.1:18888"
TOKEN="gemeniclaw-local-dev-token-2026"
SESSION="${1:-verify-$(date +%s)}"
SSH_TARGET="ssh -p 6022 pingjiangli@49.232.173.252"

call_agent() {
  local msg="$1"
  ssh -p 6022 pingjiangli@49.232.173.252 -o ConnectTimeout=10 \
    "curl -s -m 30 http://127.0.0.1:18888/v1/agent/chat \
      -H 'Authorization: Bearer $TOKEN' \
      -H 'Content-Type: application/json' \
      -d \"{\\\"message\\\":\\\"$msg\\\",\\\"session_id\\\":\\\"$SESSION\\\"}'" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response','(empty)')[:300])" 2>/dev/null
}

echo "=== GeminiClaw Verification ==="
echo "Session: $SESSION"
echo ""

echo "[1] 基础对话"
call_agent "你好，用一句话介绍你自己"
echo ""

echo "[2] 上下文保持（应该记得上一条）"
call_agent "我刚才问了你什么？"
echo ""

echo "[3] 工具调用（当前时间）"
call_agent "现在是几月几日，几点几分？"
echo ""

echo "[4] 查看 Agent 状态"
ssh -p 6022 pingjiangli@49.232.173.252 -o ConnectTimeout=10 \
  "curl -s http://127.0.0.1:18888/v1/mesh/status \
    -H 'Authorization: Bearer $TOKEN' 2>/dev/null || echo '(mesh not yet implemented)'"
echo ""

echo "=== Done ==="
