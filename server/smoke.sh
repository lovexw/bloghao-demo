#!/usr/bin/env bash
# bloghao-demo 端到端冒烟：直接跑打包产物（与 Docker 里同一条命令），对演示站的核心体验逐项断言。
# 用法：npm run smoke（内部：无 dist 则先 build → 起临时数据目录的服务 → curl 断言 → 清理）
set -u
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-18787}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d /tmp/bloghao-demo-smoke.XXXXXX)"
LOG="$DATA_DIR/server.log"
PASS=0
FAIL=0
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); say "  ✗ $1"; }

# 断言：curl 结果包含/不包含某串（含=1 不含=0）
has() { # has <描述> <url|-> <串> <期望:1|0> [curl 额外参数...]
  local desc="$1" target="$2" needle="$3" want="$4"; shift 4
  local body status
  if [ "$target" = "-" ]; then body="$(cat)"; else
    body="$(curl -s -w '\n%{http_code}' "$@" "$target")"
  fi
  status="$(printf '%s' "$body" | tail -n 1)"
  body="$(printf '%s' "$body" | sed '$d')"
  if [ "$want" = "1" ]; then
    if printf '%s' "$body" | grep -qF "$needle"; then ok "$desc"; else bad "$desc (缺: $needle)"; fi
  else
    if printf '%s' "$body" | grep -qF "$needle"; then bad "$desc (不应出现: $needle)"; else ok "$desc"; fi
  fi
}

say "▸ 构建产物"
if [ ! -f server/dist/server.js ]; then npm run build >/dev/null || { say "  ✗ build 失败"; exit 1; }; fi
ok "server/dist/server.js 就绪"

say "▸ 启动服务 · 临时数据目录: $DATA_DIR"
PORT="$PORT" TENANTS_DIR="$DATA_DIR/tenants" node server/dist/server.js >"$LOG" 2>&1 &
PIDS+=($!)

ready=0
for _ in $(seq 1 60); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" = "1" ]; then ok "健康检查 /api/health 200"; else bad "服务未就绪"; tail -20 "$LOG"; exit 1; fi
# 首个页面请求触发自动播种（含 PBKDF2），多等几轮
for _ in $(seq 1 60); do
  if curl -s "$BASE/" | grep -qF '拾光小筑'; then break; fi
  sleep 0.5
done

say "▸ 演示体验版公示（全站横幅 / noindex / 站点人设）"
has "首页含体验版横幅" "$BASE/" "演示体验版（非最新正式版）· 仅供测试体验" 1
has "首页含站点名" "$BASE/" "拾光小筑" 1
has "首页 noindex" "$BASE/" 'name="robots" content="noindex"' 1
has "任意 Host 回落到唯一演示租户" "$BASE/" "演示体验版" 1 -H 'Host: anything.example.com'

say "▸ 内容与搜索（FTS5）"
has "RSS 有条目且不含会员专享全文" "$BASE/rss.xml" "<item>" 1
curl -s "$BASE/rss.xml" | grep -qF '阅读完成率：哪些文章被读完了' && bad "RSS 泄漏会员专享全文" || ok "RSS 不含会员专享全文"
has "搜索命中文章链接" "$BASE/search?q=Cloudflare" "/post/" 1
searchResp=$(curl -s --get --data-urlencode "q=你解锁成功了" "$BASE/search")
printf '%s' "$searchResp" | grep -qF "换个关键词试试" && ok "密码文退出搜索（无结果空态）" || bad "密码文搜索异常"

say "▸ 会员体系（公示账号 + 付费墙）"
has "会员专享文未登录：付费墙卡" "$BASE/post/member-exclusive-annual-data" "会员专属内容" 1
has "会员专享文未登录：正文服务端截断" "$BASE/post/member-exclusive-annual-data" "阅读完成率：哪些文章被读完了" 0
curl -s -c "$DATA_DIR/member.jar" -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo1234"}' "$BASE/api/member/login" >"$DATA_DIR/login.json"
grep -qF '"ok":true' "$DATA_DIR/login.json" && ok "演示会员登录成功（demo / demo1234）" || { bad "演示会员登录失败"; cat "$DATA_DIR/login.json"; }
has "会员登录后解锁全文" "$BASE/post/member-exclusive-annual-data" "阅读完成率：哪些文章被读完了" 1 -b "$DATA_DIR/member.jar"
has "排行榜有演示会员" "$BASE/rank" "体验访客" 1
has "会员中心表单渲染" "$BASE/member" "mem-auth" 1

say "▸ 文章访问密码"
has "密码文：解锁表单" "$BASE/post/password-locked-demo" "本文章已加密" 1
codeUnlock=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' -d 'password=demo9999' "$BASE/post/password-locked-demo/unlock")
printf '%s' "$codeUnlock" | grep -q '303' && printf '%s' "$codeUnlock" | grep -qF 'pwerr=1' && ok "错误密码 303 回显错误态" || bad "错误密码行为异常：$codeUnlock"
codeUnlock2=$(curl -s -c "$DATA_DIR/pp.jar" -o /dev/null -w '%{http_code}' -d 'password=demo1234' "$BASE/post/password-locked-demo/unlock")
[ "$codeUnlock2" = "303" ] && ok "正确密码 303 签发解锁 Cookie" || bad "正确密码状态码：$codeUnlock2"
has "解锁后可见全文" "$BASE/post/password-locked-demo" "你解锁成功了" 1 -b "$DATA_DIR/pp.jar"

say "▸ 后台与演示守卫"
has "/api/auth/state 公示 demo 标记" "$BASE/api/auth/state" '"demo":true' 1
curl -s -c "$DATA_DIR/admin.jar" -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo1234"}' "$BASE/api/auth/login" >"$DATA_DIR/admin.json"
grep -qF '"ok":true' "$DATA_DIR/admin.json" && ok "管理员登录成功（demo / demo1234）" || { bad "管理员登录失败"; cat "$DATA_DIR/admin.json"; }
has "后台 SPA 直出" "$BASE/admin/" "博客号后台" 1
pwResp=$(curl -s -X PUT -b "$DATA_DIR/admin.jar" -H 'Content-Type: application/json' \
  -d '{"old":"demo1234","next":"abcd12345"}' "$BASE/api/admin/password")
printf '%s' "$pwResp" | grep -qF '演示站不支持修改密码' && ok "演示守卫：禁改密码（403）" || bad "禁改密码守卫异常：$pwResp"

say ""
if [ "$FAIL" = "0" ]; then say "✓ 冒烟结果：$PASS/$((PASS + FAIL)) 通过 (数据目录已清理)"; exit 0
else say "✗ 冒烟结果：$PASS/$((PASS + FAIL)) 通过, $FAIL 失败 (日志: $LOG)"; exit 1; fi
