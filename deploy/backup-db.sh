#!/usr/bin/env bash
# ============================================================
# data/db.json 每日快照备份
#
# 为什么必须备份：db.json 里存着审核单、订阅、采集队列，以及
# 「飞书多维表格写权限失效时暂存的待同步写操作（syncOutbox）」。
# 这个文件丢了 = 用户的写操作凭空消失，且无法从飞书侧找回。
#
# 安装（每天 03:15 执行一次，保留 30 天）：
#   sudo mkdir -p /var/backups/policy-kb
#   sudo cp deploy/backup-db.sh /opt/policy-kb/deploy/
#   sudo chmod +x /opt/policy-kb/deploy/backup-db.sh
#   echo '15 3 * * * root /opt/policy-kb/deploy/backup-db.sh >> /var/log/policy-kb/backup.log 2>&1' \
#     | sudo tee /etc/cron.d/policy-kb-backup
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/policy-kb}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/policy-kb}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
mkdir -p "$(dirname /var/log/policy-kb/backup.log)" 2>/dev/null || true

SRC="$APP_DIR/data/db.json"
STAMP="$(date +%F-%H%M%S)"

if [ ! -f "$SRC" ]; then
  echo "[$(date -Is)] 跳过：$SRC 不存在"
  exit 0
fi

# 用 cp 而非 mv：db.json 是进程持有的活动文件，mv 会让进程写到已删除的 inode
DEST="$BACKUP_DIR/db-$STAMP.json"
cp "$SRC" "$DEST"

# 校验：能被引擎解析成 JSON 才算备份成功
if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$DEST" 2>/dev/null; then
  gzip -f "$DEST"
  echo "[$(date -Is)] 备份成功 -> $DEST.gz"
else
  echo "[$(date -Is)] 警告：备份文件不是合法 JSON，保留原文待查 -> $DEST"
fi

# 清理过期备份
find "$BACKUP_DIR" -name 'db-*.json.gz' -type f -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'db-*.json' -type f -mtime +"$KEEP_DAYS" -delete

echo "[$(date -Is)] 清理完成，保留最近 ${KEEP_DAYS} 天，当前备份数：$(ls -1 "$BACKUP_DIR" | wc -l)"
