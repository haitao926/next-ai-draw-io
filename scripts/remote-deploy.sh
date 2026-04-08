#!/bin/bash
# Remote-only deploy script: pull latest code, install deps, build, start (no Docker)
set -euo pipefail

PORT=${PORT:-8100}
BRANCH=${BRANCH:-main}
LOG_FILE=${LOG_FILE:-/tmp/next-ai-draw-io.log}

# Move to repo root (script lives in scripts/)
cd "$(dirname "$0")/.."

info() { echo -e "\033[0;34m$1\033[0m"; }
success() { echo -e "\033[0;32m$1\033[0m"; }
warn() { echo -e "\033[1;33m$1\033[0m"; }
fail() { echo -e "\033[0;31m$1\033[0m"; exit 1; }

ensure_git() {
  if ! command -v git >/dev/null 2>&1; then
    fail "git 未安装，请先安装 git"
  fi
}

ensure_node() {
  if ! command -v npm >/dev/null 2>&1; then
    fail "npm 未安装，请先安装 Node.js/npm"
  fi
}

pull_latest() {
  info "📥 拉取最新代码 (branch: ${BRANCH})..."
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git reset --hard "origin/${BRANCH}"
  success "✅ 已同步到 origin/${BRANCH}"
}

ensure_env() {
  if [ ! -f .env ]; then
    warn "⚠️  未检测到 .env，正在从 env.example 复制..."
    cp env.example .env
  else
    success "✅ .env 已存在"
  fi
}

install_build() {
  info "📦 安装依赖 (npm install --omit=dev)..."
  npm install --omit=dev
  info "🏗️  构建应用 (npm run build)..."
  npm run build
}

start_app() {
  info "🚀 重启应用，端口: ${PORT}，日志: ${LOG_FILE}"
  pkill -f "npm start -- -p ${PORT}" >/dev/null 2>&1 || true
  PORT=${PORT} nohup npm start -- -p "${PORT}" >"${LOG_FILE}" 2>&1 &
  success "✅ 启动完成，查看日志: tail -f ${LOG_FILE}"
}

main() {
  ensure_git
  ensure_node
  pull_latest
  ensure_env
  install_build
  start_app
}

main "$@"
