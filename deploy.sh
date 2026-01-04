#!/bin/bash
set -euo pipefail

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 可自定义变量
PORT=${PORT:-8100}                           # 本地/远程启动端口
BRANCH=${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)} # 推送和部署的分支
REMOTE_REPO=${REMOTE_REPO:-$(git config --get remote.origin.url)}
# 远程服务器列表："user@host:/remote/path"
REMOTE_SERVERS=(
  "root@10.20.202.195:/opt/next-ai-draw-io"
)
# 是否在本机也启动（保持原有行为），设置为 false 则仅推送+远程部署
LOCAL_START=${LOCAL_START:-true}

if [ -z "${REMOTE_REPO}" ]; then
  echo -e "${RED}❌ 未检测到 git 远程仓库，请先配置 origin 地址${NC}"
  exit 1
fi

echo -e "${BLUE}🚀 开始一键推送并部署 Next AI Draw.io ...${NC}"

info() { echo -e "${BLUE}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
fail() { echo -e "${RED}$1${NC}"; exit 1; }

ensure_env() {
  if [ ! -f .env ]; then
    warn "⚠️  未检测到 .env 文件，正在从 env.example 复制..."
    cp env.example .env
  else
    success "✅ .env 文件已存在"
  fi
}

git_sync() {
  info "📤 准备推送到远程仓库 (${BRANCH})..."
  if [ -n "$(git status --porcelain)" ]; then
    read -r -p "请输入本次提交信息（回车将使用默认）： " msg
    msg=${msg:-"chore: deploy $(date +%Y-%m-%d_%H-%M)"}
    git add -A
    git commit -m "${msg}"
    success "✅ 已提交：${msg}"
  else
    warn "ℹ️  工作区干净，无需提交"
  fi
  git push origin "${BRANCH}"
  success "✅ 已推送到 ${REMOTE_REPO} (${BRANCH})"
}

install_deps() {
  info "📦 正在安装依赖 (npm install)..."
  npm install
}

build_app() {
  info "🏗️  正在构建应用 (npm run build)..."
  npm run build
}

start_local() {
  success "✅ 本地构建完成"
  info "🌍 正在本地启动服务，端口: ${PORT} ..."
  warn "👉 请访问: http://localhost:${PORT} (或使用本机局域网 IP)"
  export PORT
  npm start -- -p "${PORT}"
}

deploy_remote() {
  if [ ${#REMOTE_SERVERS[@]} -eq 0 ]; then
    warn "⚠️  未配置远程服务器，跳过远程部署"
    return
  fi

  for target in "${REMOTE_SERVERS[@]}"; do
    host="${target%%:*}"
    path="${target#*:}"
    if [ -z "${host}" ] || [ "${path}" = "${host}" ]; then
      fail "❌ 远程服务器格式错误（需 user@host:/path）：${target}"
    fi

    info "🌐 正在部署到 ${host}:${path} ..."
    ssh "${host}" "REMOTE_PATH='${path}' REMOTE_REPO='${REMOTE_REPO}' BRANCH='${BRANCH}' PORT='${PORT}' bash -s <<REMOTE_SCRIPT
set -euo pipefail
if [ ! -d \"${REMOTE_PATH}\" ]; then
  mkdir -p \"${REMOTE_PATH}\"
fi
if [ ! -d \"${REMOTE_PATH}/.git\" ]; then
  git clone \"${REMOTE_REPO}\" \"${REMOTE_PATH}\"
fi
cd \"${REMOTE_PATH}\"
git fetch origin \"${BRANCH}\"
git checkout \"${BRANCH}\"
git reset --hard \"origin/${BRANCH}\"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose pull || true
  docker compose up -d --build
else
  npm install --omit=dev
  npm run build
  # 若有进程管理器可替换此处为 pm2/systemd 等
  pkill -f \"npm start -- -p ${PORT}\" >/dev/null 2>&1 || true
  PORT=${PORT} nohup npm start -- -p \"${PORT}\" >/tmp/next-ai-draw-io.log 2>&1 &
fi
REMOTE_SCRIPT"
    success "✅ ${host} 部署完成"
  done
}

main() {
  ensure_env
  install_deps
  build_app
  git_sync
  deploy_remote

  if [ "${LOCAL_START}" = "true" ]; then
    start_local
  else
    success "✅ 本地构建完成，已推送并完成远程部署（未本地启动）"
  fi
}

main "$@"
