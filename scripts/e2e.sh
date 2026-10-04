#!/usr/bin/env bash
# 本地端到端联调：启动飞书模拟服务器 + fsmore 实例（隔离数据目录），跑通核心链路后提示手动体验。
# 用法：bash scripts/e2e.sh   （Ctrl+C 退出并清理）
set -euo pipefail
cd "$(dirname "$0")/.."

MOCK_PORT="${MOCK_FEISHU_PORT:-7999}"
APP_PORT="${FSMORE_PORT:-7890}"
DATA_DIR="$(pwd)/data-e2e"

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

MOCK_FEISHU_PORT="$MOCK_PORT" node scripts/mock-feishu.mjs &
MOCK_PID=$!
sleep 1

FSMORE_DATA_DIR="$DATA_DIR" FSMORE_PORT="$APP_PORT" \
FSMORE_API_BASE="http://127.0.0.1:$MOCK_PORT/open-apis" \
  npx tsx src/index.ts &
APP_PID=$!
sleep 2

B="http://127.0.0.1:$APP_PORT"
curl -s -X POST "$B/api/config" -H "content-type: application/json" -d '{"appId":"cli_mock","appSecret":"secret_mock"}' > /dev/null
ROOT=$(curl -s -X POST "$B/api/roots" -H "content-type: application/json" \
  -d '{"link":"http://mock.feishu.cn/wiki/wikmockroot01"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rootId))")
JOB=$(curl -s -X POST "$B/api/sync/root" -H "content-type: application/json" -d "{\"rootId\":\"$ROOT\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).jobId))")
sleep 3
echo ""
echo "── 端到端数据已就绪 ──────────────────────────────"
echo "  Web 控制台:  $B"
echo "  MCP 端点:    $B/mcp"
echo "  同步任务:    $JOB"
echo "  工作区:      $DATA_DIR/workspace"
echo "──────────────────────────────────────────────────"
echo "按 Ctrl+C 退出"
wait "$APP_PID"
