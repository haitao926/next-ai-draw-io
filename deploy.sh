#!/bin/bash
set -e

# 配置 (支持环境变量覆盖)
PORT=${PORT:-8100}
SERVICE_NAME="next-ai-draw-io"

# 尝试加载 NVM 环境 (如果存在)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

echo "📦 1. 检查环境与依赖..."
if [ ! -f .env ]; then 
    echo "   -> 复制 env.example 到 .env"
    cp env.example .env
fi

npm install

echo "🏗️  2. 构建应用..."
# 内存优化：设置 Node.js 内存限制为系统总内存的 75%，防止小内存服务器死机
if [ -f /proc/meminfo ]; then
    TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    # 转换为 MB 并乘以 0.75
    NODE_MEM_LIMIT=$((TOTAL_MEM_KB / 1024 * 3 / 4))
    echo "   -> 检测到系统内存，设置 Node.js 内存限制: ${NODE_MEM_LIMIT}MB"
    export NODE_OPTIONS="--max-old-space-size=${NODE_MEM_LIMIT}"
fi

npm run build

echo "🚀 3. 启动服务..."
if [ "${INSTALL_SERVICE}" = "true" ]; then
    echo "   -> 配置 Systemd 开机自启 (需要 sudo 密码)..."
    
    # 构造启动命令的前缀，确保 systemd 能找到 node
    CMD_PREFIX=""
    if [ -n "$NVM_DIR" ]; then
        CMD_PREFIX="export NVM_DIR=$NVM_DIR; [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh;"
    fi
    
    # 写入服务文件
    sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=Next AI Draw.io
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
Environment=PORT=${PORT}
ExecStart=/bin/bash -c '${CMD_PREFIX} npm start -- -p ${PORT}'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "${SERVICE_NAME}"
    sudo systemctl restart "${SERVICE_NAME}"
    echo "✅ Systemd 服务已安装并启动: systemctl status ${SERVICE_NAME}"
else
    # 普通后台启动
    pkill -f "npm start -- -p ${PORT}" || true
    PORT=${PORT} nohup npm start -- -p "${PORT}" > run.log 2>&1 &
    echo "✅ 应用已后台启动，日志查看: tail -f run.log"
fi
