#!/usr/bin/env bash
# ============================================================
# 一键部署 / 更新（裸机 + systemd 场景）
#
#   cd /opt/policy-kb
#   sudo APP_DIR=/opt/policy-kb ./deploy/deploy.sh
#
# 流程：备份 db.json → 拉代码 → 装依赖 → 校验前端随包 → 重启 → 健康探测
# 任一步失败立即退出，不会让服务停在半死不活的状态。
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/policy-kb}"
SERVICE="${SERVICE:-policy-kb}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"

log() { echo -e "\033[36m[deploy]\033[0m $*"; }
warn() { echo -e "\033[33m[deploy]\033[0m $*"; }
fail() { echo -e "\033[31m[deploy][fail]\033[0m $*" >&2; exit 1; }

[ -d "$APP_DIR" ] || fail "目录不存在：$APP_DIR"
cd "$APP_DIR"

# ① 更新前先备份 db.json（最坏情况也能回滚数据）
log "① 备份 data/db.json"
mkdir -p data
if [ -f data/db.json ]; then
  cp data/db.json "data/db.predeploy-$(date +%F-%H%M%S).json"
fi

# ② 拉代码
log "② 拉取代码（$BRANCH）"
if [ -d .git ]; then
  git fetch --all --prune
  git checkout "$BRANCH"
  git pull --ff-only || warn "git pull 失败，继续用现有代码部署"
else
  warn "不是 git 仓库，跳过拉取（请自行 rsync 代码到 $APP_DIR）"
fi

# ③ 装依赖
log "③ 安装生产依赖"
npm install --omit=dev --no-audit --no-fund

# ④ 前端（自建：总览首页 / 与审批台 /admin/ 随包托管于 policy-api/public/，无需额外产物）
log "④ 校验自建前端"
[ -f policy-api/public/index.html ] && [ -f policy-api/public/admin/index.html ] \
  || warn "policy-api/public 下缺少 index.html / admin/index.html，页面将不可用"

# ⑤ 环境变量体检（缺关键变量直接停，不要重启出一个坏服务）
log "⑤ 环境变量体检"
node scripts/preflight.js --local || fail "预检未通过，已中止重启（服务仍运行旧版本）"

# ⑥ 重启
log "⑥ 重启 $SERVICE"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^$SERVICE"; then
  systemctl restart "$SERVICE"
elif command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "$SERVICE"; then
  pm2 restart "$SERVICE" --update-env
else
  fail "找不到 systemctl 或 pm2 中的服务 $SERVICE"
fi

# ⑦ 健康探测（最多等 30 秒）
log "⑦ 健康探测 $HEALTH_URL"
for i in $(seq 1 15); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "✅ 服务已就绪"
    exit 0
  fi
  sleep 2
done

fail "30 秒内 /healthz 未响应，请检查日志：journalctl -u $SERVICE -n 100"
