#!/usr/bin/env bash
#
# 宏观研究看板 · 一键部署（Ubuntu 22.04 / 24.04，Debian 12 亦可）
#
# 幂等：全新机器能装，已装过的机器重复执行等于「更新代码 + 重启服务」。
#
# 用法：
#   git clone <仓库地址> && cd macro-research-board
#   sudo bash deploy/install.sh
#
# 可选环境变量：
#   APP_DIR   安装目录            默认 /opt/macro-board
#   APP_USER  运行用户            默认 ubuntu（不存在则用 root 的登录用户）
#   PORT      Node 监听端口       默认 8080（仅 127.0.0.1）
#   HTTP_PORT nginx 对外端口      默认 80
#   DOMAIN    域名，留空则只跑 HTTP；填了会在末尾自动签证书
#   EMAIL     证书通知邮箱（DOMAIN 非空时建议填）
#   SKIP_FETCH=1  首次部署不抓数，直接用仓库里的 data.json 快照
#
set -euo pipefail

# ---------- 提权 ----------
if [[ ${EUID} -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/macro-board}"
PORT="${PORT:-8080}"
HTTP_PORT="${HTTP_PORT:-80}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
STALE_HOURS="${STALE_HOURS:-6}"
SKIP_FETCH="${SKIP_FETCH:-0}"

if [[ -n "${APP_USER:-}" ]]; then
  RUN_USER="$APP_USER"
elif id -nG ubuntu >/dev/null 2>&1 || getent passwd ubuntu >/dev/null 2>&1; then
  RUN_USER="ubuntu"
else
  RUN_USER="${SUDO_USER:-root}"
fi

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$SRC/server.js" && -f "$SRC/fetch_data.py" ]] || die "没找到 server.js / fetch_data.py，请在仓库根目录执行 deploy/install.sh"
command -v systemctl >/dev/null || die "需要 systemd 的 Linux 发行版"

say "配置"
ok "源码目录   $SRC"
ok "安装目录   $APP_DIR"
ok "运行用户   $RUN_USER"
ok "Node 端口  127.0.0.1:$PORT"
ok "对外端口   $HTTP_PORT"
ok "域名       ${DOMAIN:-（未设置，只跑 HTTP）}"

# ---------- 1. 系统依赖 ----------
say "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip nginx certbot rsync curl ca-certificates >/tmp/mb-apt.log 2>&1 \
  || { tail -20 /tmp/mb-apt.log; die "apt 安装失败"; }

if ! command -v node >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends nodejs >/tmp/mb-apt-node.log 2>&1 \
    || { tail -20 /tmp/mb-apt-node.log; die "Node 安装失败"; }
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -v | sed 's/^v\([0-9]*\).*/\1/')"
(( NODE_MAJOR >= 18 )) || warn "Node 版本 $("$NODE_BIN" -v) 偏低，建议 18 以上"
ok "nginx $(nginx -v 2>&1 | sed 's/.*nginx\///')"
ok "certbot $(certbot --version 2>&1 | awk '{print $2}')"
ok "node $("$NODE_BIN" -v)  $NODE_BIN"

# ---------- 2. 同步代码 ----------
say "同步代码到 $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'venv/' \
  --exclude 'node_modules/' \
  --exclude 'preview/' \
  --exclude '.backup_*' \
  --exclude '*.zip' \
  --exclude '*.bak' \
  --exclude 'data.json' \
  "$SRC"/ "$APP_DIR"/
ok "代码已同步（data.json 与 venv 不覆盖）"

# ---------- 3. Python 环境 ----------
say "准备 Python 环境（首次约 1-3 分钟）"
if [[ ! -x "$APP_DIR/venv/bin/python" ]]; then
  python3 -m venv "$APP_DIR/venv"
  ok "已创建 venv"
else
  ok "复用已有 venv"
fi
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
"$APP_DIR/venv/bin/python" - <<'PY'
import akshare, pandas, sys
print(f"    \033[32m✓\033[0m python {sys.version.split()[0]}  akshare {akshare.__version__}  pandas {pandas.__version__}")
PY

# ---------- 4. 数据 ----------
say "准备数据"
if [[ ! -f "$APP_DIR/data.json" ]]; then
  if [[ -f "$SRC/data.json" ]]; then
    cp "$SRC/data.json" "$APP_DIR/data.json"
    ok "用仓库内的 data.json 快照起步"
  fi
fi
[[ -f "$APP_DIR/data.json" ]] || warn "没有 data.json，服务起来后会自动抓一次"
[[ -f "$APP_DIR/data.json" ]] && ok "data.json 就绪（$(du -h "$APP_DIR/data.json" | cut -f1)）"

if [[ "$SKIP_FETCH" != "1" && ! -f "$APP_DIR/data.json" ]]; then
  say "首次抓数（约 1-3 分钟）"
  ( cd "$APP_DIR" && "$APP_DIR/venv/bin/python" fetch_data.py ) || warn "抓数失败，稍后服务会自动重试"
fi

# 静态兜底副本（给 GitHub Pages / Cloudflare Pages 用）
[[ -f "$APP_DIR/data.json" ]] && cp "$APP_DIR/data.json" "$APP_DIR/public/data.json"

# ---------- 5. systemd ----------
say "配置常驻服务"
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__APP_USER__|$RUN_USER|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__STALE_HOURS__|$STALE_HOURS|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$SRC/deploy/macro-board.service.tpl" > /etc/systemd/system/macro-board.service
systemctl daemon-reload
systemctl enable macro-board >/dev/null 2>&1
systemctl restart macro-board
sleep 2
systemctl is-active --quiet macro-board || { journalctl -u macro-board -n 20 --no-pager; die "服务启动失败"; }
ok "macro-board.service 已启动并设为开机自启"

# ---------- 6. nginx ----------
say "配置 nginx 反向代理"
mkdir -p /var/www/acme
chown -R www-data:www-data /var/www/acme
install -d /etc/nginx/sites-available /etc/nginx/sites-enabled

if [[ -n "$DOMAIN" && -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  bash "$SRC/deploy/setup-https.sh" "$DOMAIN" "$EMAIL" || warn "HTTPS 配置未生效，先保持 HTTP"
else
  sed -e "s|__HTTP_PORT__|$HTTP_PORT|g" \
      -e "s|__SERVER_NAME__|${DOMAIN:-_}|g" \
      -e "s|__BACKEND__|127.0.0.1:$PORT|g" \
      "$SRC/deploy/nginx-http.conf.tpl" > /etc/nginx/sites-available/macro-board
  ln -sf /etc/nginx/sites-available/macro-board /etc/nginx/sites-enabled/macro-board
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置有误"; }
  systemctl enable nginx >/dev/null 2>&1
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  ok "nginx 已就绪：:$HTTP_PORT → 127.0.0.1:$PORT"
fi

# ---------- 7. 权限 ----------
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
chmod +x "$SRC"/deploy/*.sh

# ---------- 8. 自检 ----------
say "自检"
sleep 1
API="$(curl -fsS "http://127.0.0.1:$PORT/api/status" || true)"
[[ -n "$API" ]] && ok "应用 /api/status: $API" || warn "应用接口无响应"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/" || true)"
[[ "$CODE" == "200" ]] && ok "nginx 首页 HTTP $CODE" || warn "nginx 首页返回 $CODE"

# 公网 IP：按顺序试几个服务，都失败才退回内网地址
pub_ip() {
  local v
  for u in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip https://myip.ipip.net; do
    v="$(curl -fsS --max-time 6 "$u" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"
    [[ -n "$v" ]] && { echo "$v"; return 0; }
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}
IP="$(pub_ip)"
if [[ "$IP" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  warn "探测到的是内网地址 $IP，请在控制台确认公网 IP"
  IP="你的公网IP"
fi
if [[ "$HTTP_PORT" == "80" ]]; then VISIT="http://$IP"; else VISIT="http://$IP:$HTTP_PORT"; fi
say "部署完成"
cat <<TXT
    访问地址   $VISIT
    服务管理   systemctl status macro-board
               systemctl restart macro-board
               journalctl -u macro-board -f
    更新代码   cd 仓库 && git pull && sudo bash deploy/install.sh

    如果外网打不开，去云厂商控制台的防火墙放行 TCP $HTTP_PORT
    （腾讯云轻量：实例 → 防火墙 → 添加规则 → 自定义 TCP）
TXT

if [[ -n "$DOMAIN" ]]; then
  cat <<TXT

    下一步   域名解析生效后跑：
             sudo bash deploy/setup-https.sh $DOMAIN ${EMAIL:-you@example.com}
TXT
fi
