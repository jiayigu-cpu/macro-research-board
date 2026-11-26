#!/usr/bin/env bash
# 把本目录推送到你的 GitHub 仓库。
# 用法： ./deploy-github.sh <GitHub 用户名> [仓库名]
# 例：   ./deploy-github.sh doreen macro-research-board
set -euo pipefail

USER_NAME="${1:-}"
REPO="${2:-macro-research-board}"

if [ -z "$USER_NAME" ]; then
  echo "用法: ./deploy-github.sh <GitHub 用户名> [仓库名]"
  echo "请先在 https://github.com/new 创建一个空仓库（不要勾选 README / .gitignore / license）"
  exit 1
fi

URL="https://github.com/${USER_NAME}/${REPO}.git"

git remote remove origin 2>/dev/null || true
git remote add origin "$URL"
git push -u origin main

cat <<EOF

推送完成：${URL}

还剩两步在浏览器里点一下：
  1. 打开 ${URL}/settings/pages ，把 Source 选为「GitHub Actions」
  2. 打开 ${URL}/actions ，选 deploy-pages，点 Run workflow

站点地址形如： https://${USER_NAME}.github.io/${REPO}/
EOF
