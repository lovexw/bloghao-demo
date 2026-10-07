#!/bin/sh
# 从博客号主仓库（xwblog 开发仓库）同步最新演示站代码到本仓库。
# 同步范围：src/（业务代码 + 演示引擎）、public/（后台 SPA / 插件 / 市场）、schema.sql。
# 用法：scripts/sync-from-bloghao.sh [主仓库路径]，缺省取 $BLOGHAO_REPO，再缺省 ../xiaowu-bloghao
set -e
cd "$(dirname "$0")/.."

SRC="${1:-${BLOGHAO_REPO:-../xiaowu-bloghao}}"
if [ ! -f "$SRC/schema.sql" ] || [ ! -d "$SRC/src" ]; then
  echo "✗ 主仓库不存在或缺少 schema.sql/src：$SRC"
  echo "  用法：scripts/sync-from-bloghao.sh /path/to/xiaowu-bloghao"
  exit 1
fi

command -v rsync >/dev/null || { echo "✗ 需要 rsync"; exit 1; }

echo "▸ 同步 $SRC → $PWD"
rsync -a --delete "$SRC/src/" src/
rsync -a --delete "$SRC/public/" public/
cp "$SRC/schema.sql" schema.sql

REV="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
git add -A
if git diff --cached --quiet; then
  echo "✓ 已是最新 (主仓库 @ $REV), 无变更"
else
  git commit -m "sync: 同步 xwblog@$REV"
  echo "✓ 已提交。部署：docker compose up --build -d"
fi
