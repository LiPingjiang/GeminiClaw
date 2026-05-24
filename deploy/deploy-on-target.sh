#!/bin/bash
# 在部署目标机器上运行：git pull + build + restart
# 用法：bash deploy/deploy-on-target.sh [branch]

set -e

BRANCH=${1:-evolution/skill-bootstrap-1778674781762}
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] Working dir: $DIR"
echo "[deploy] Branch: $BRANCH"

cd "$DIR"

# 拉代码
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"
echo "[deploy] Code updated"

# 安装依赖（如果 package.json 有变化）
# PUPPETEER_SKIP_DOWNLOAD=true: skip Chromium download, use system Chrome instead
export PUPPETEER_SKIP_DOWNLOAD=true
npm install --prefer-offline 2>/dev/null || npm install
echo "[deploy] Dependencies ready"

# 编译
npm run build
echo "[deploy] Build done"

# 重启服务
PORT=18888
PIDFILE="$DIR/.pid"

if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  kill "$OLD_PID" 2>/dev/null && echo "[deploy] Stopped old process $OLD_PID" || true
  rm -f "$PIDFILE"
fi

# 也杀掉占用端口的进程
lsof -ti tcp:$PORT | xargs kill -9 2>/dev/null || true
sleep 1

# 启动
nohup node dist/index.js > server.log 2>&1 &
echo $! > "$PIDFILE"
echo "[deploy] Started PID $(cat $PIDFILE)"

sleep 2
tail -5 server.log
