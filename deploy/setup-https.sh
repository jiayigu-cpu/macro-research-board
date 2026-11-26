#!/usr/bin/env bash
#
# 给看板绑定域名并开启 HTTPS（Let's Encrypt 免费证书，自动续期）
#
# 用法：
#   sudo bash deploy/setup-https.sh board.example.com you@example.com
#
# 环境变量：
#   HTTPS_PORT  额外监听的备用端口，默认 8443
#               （国内地域未备案域名常被拦 443，备用端口能绕开）
#   STRICT=1    DNS 未指向本机时直接报错退出
#
# 说明：
#   · 证书验证走 80 端口的 /.well-known/acme-challenge/，由 nginx 静态返回
#   · 续期由 certbot 自带的 systemd timer 负责，续期后自动 reload nginx
#   · 重复执行是安全的：证书还有 30 天以上就直接复用，只重写 nginx 配置
#
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${1:-}"
EMAIL="${2:-${EMAIL:-}}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
BACKEND="${BACKEND:-127.0.0.1:8080}"
HTTP_PORT="${HTTP_PORT:-80}"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$DOMAIN" ]] || die "用法：sudo bash deploy/setup-https.sh 你的域名 [邮箱]"
[[ "$DOMAIN" == *.* ]] || die "域名格式不对：$DOMAIN"

# ---------- 1. DNS 自检 ----------
say "检查域名解析"
SERVER_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
[[ -n "$SERVER_IP" ]] && ok "本机公网 IP  $SERVER_IP"
if [[ -z "$DNS_IP" ]]; then
  warn "域名 $DOMAIN 还没有解析记录"
  [[ "${STRICT:-0}" == "1" ]] && die "解析未生效，先加 A 记录指向 $SERVER_IP"
elif [[ -n "$SERVER_IP" && "$DNS_IP" != "$SERVER_IP" ]]; then
  warn "解析指向 $DNS_IP，与本机 $SERVER_IP 不一致"
  [[ "${STRICT:-0}" == "1" ]] && die "解析不一致，请先改成 A 记录 → $SERVER_IP"
else
  ok "解析指向 $DNS_IP"
fi

# ---------- 2. 证书 ----------
install -d -o www-data -g www-data /var/www/acme

cert_alive() {
  [[ -f "$CERT_DIR/fullchain.pem" ]] || return 1
  openssl x509 -checkend $((30 * 86400)) -noout -in "$CERT_DIR/fullchain.pem" >/dev/null 2>&1
}

say "申请证书"
if cert_alive; then
  ok "已有有效证书，跳过申请"
  openssl x509 -noout -subject -enddate -in "$CERT_DIR/fullchain.pem" | sed 's/^/    /'
else
  EMAIL_ARGS=(--register-unsafely-without-email)
  [[ -n "$EMAIL" ]] && EMAIL_ARGS=(-m "$EMAIL")
  if certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" \
      --non-interactive --agree-tos "${EMAIL_ARGS[@]}" --keep-until-expiring; then
    ok "证书签发成功"
  else
    cat <<TXT

    HTTP 验证失败，常见原因按概率排序：
      1. 域名还没解析到本机，或解析刚加还没生效（等 10 分钟再试）
      2. 国内地域未备案域名的 80 端口被云厂商拦截 —— 看下面「DNS 验证」方案
      3. 云防火墙没放行 80 端口

    改用 DNS 验证（域名在哪家 DNS 就在哪家加一条 TXT 记录）：
      sudo certbot certonly --manual --preferred-challenges dns -d $DOMAIN
      # 按提示添加 _acme-challenge.$DOMAIN 的 TXT 记录，回车继续
      # 拿到证书后重新跑一次本脚本，它会跳过申请直接配 nginx

    如果 DNS 在腾讯云 DNSPod，也可以装插件让续期全自动：
      sudo pip3 install --break-system-packages certbot-dns-dnspod
      # 然后在 DNSPod 控制台创建 API 密钥，写入 /etc/letsencrypt/dnspod.ini
TXT
    exit 1
  fi
fi

# ---------- 3. nginx 配置 ----------
say "写入 nginx 配置"
if [[ "$HTTPS_PORT" == "443" ]]; then
  LISTEN_LINES="    listen 443 ssl http2;\n    listen [::]:443 ssl http2;"
  REDIRECT='https://$host$request_uri'
else
  LISTEN_LINES="    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n    listen $HTTPS_PORT ssl http2;\n    listen [::]:$HTTPS_PORT ssl http2;"
  REDIRECT="https://\$host:$HTTPS_PORT\$request_uri"
fi

sed -e "s|__HTTP_PORT__|$HTTP_PORT|g" \
    -e "s|__BACKEND__|$BACKEND|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__REDIRECT__|$REDIRECT|g" \
    -e "s|__HTTPS_LISTEN__|$LISTEN_LINES|" \
    "$SRC/deploy/nginx-https.conf.tpl" > /etc/nginx/sites-available/macro-board

ln -sf /etc/nginx/sites-available/macro-board /etc/nginx/sites-enabled/macro-board
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置有误，已保留上一版未生效"; }
systemctl reload nginx 2>/dev/null || systemctl restart nginx
ok "已监听 443 与 $HTTPS_PORT，80 整站跳转"

# ---------- 4. 自动续期钩子 ----------
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
ok "续期钩子已装（certbot.timer 每天检查两次）"

# ---------- 5. 自检 ----------
say "本机自检"
for p in 443 "$HTTPS_PORT"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:$p:127.0.0.1" "https://$DOMAIN:$p/" || true)"
  [[ "$code" == "200" ]] && ok "https://$DOMAIN:$p/  → $code" || warn "https://$DOMAIN:$p/  → ${code:-失败}"
done

say "完成"
echo "    对外访问先试   https://$DOMAIN"
echo "    如果 443 打不开（未备案域名常见），用   https://$DOMAIN:$HTTPS_PORT"
echo "    手动验证续期   sudo certbot renew --dry-run"
echo
echo "    云防火墙要放行 TCP 443 与 $HTTPS_PORT，否则外网连不上"
