#!/bin/bash

# 仅限 Linux 使用
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "❌ 错误: 此脚本仅适用于 Linux 系统 (Systemd)。Mac OS 请使用 launchd 或手动启动。"
    exit 1
fi

SERVICE_NAME="next-ai-draw-io"
APP_DIR=$(pwd)
CURRENT_USER=$(whoami)
# 尝试找到 npm 的绝对路径，因为 systemd 需要绝对路径
NPM_PATH=$(which npm)
PORT=8100

if [ -z "$NPM_PATH" ]; then
    echo "⚠️  无法自动找到 npm 路径，假设为 /usr/bin/npm"
    NPM_PATH="/usr/bin/npm"
fi

echo "🚀 配置 Linux 开机自启服务..."
echo "--------------------------------"
echo "📂 应用目录: $APP_DIR"
echo "👤 运行用户: $CURRENT_USER"
echo "🛠️  NPM 路径: $NPM_PATH"
echo "🔌 运行端口: $PORT"
echo "--------------------------------"

# 生成 service 文件内容
SERVICE_CONTENT="[Unit]
Description=Next AI Draw.io Web Service
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$APP_DIR
# 使用 npm start 启动，并传入端口参数
ExecStart=$NPM_PATH start -- -p $PORT
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=$PORT
# 如果需要更多环境变量，可以在这里添加，例如:
# EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target"

# 写入临时文件
echo "$SERVICE_CONTENT" > ${SERVICE_NAME}.service

echo "📋 生成服务文件: ${SERVICE_NAME}.service"

# 需要 sudo 权限移动到系统目录
echo "🔒 需要管理员权限来安装服务..."
sudo mv ${SERVICE_NAME}.service /etc/systemd/system/

echo "🔄 重新加载 systemd 守护进程..."
sudo systemctl daemon-reload

echo "✅ 启用开机自启..."
sudo systemctl enable ${SERVICE_NAME}

echo "▶️  立即启动服务..."
sudo systemctl start ${SERVICE_NAME}

echo "--------------------------------"
echo "🎉 安装完成！"
echo "📊 查看状态: sudo systemctl status ${SERVICE_NAME}"
echo "📜 查看日志: sudo journalctl -u ${SERVICE_NAME} -f"
echo "🛑 停止服务: sudo systemctl stop ${SERVICE_NAME}"
echo "🔁 重启服务: sudo systemctl restart ${SERVICE_NAME}"
