#!/bin/bash

# Fengyu PostgreSQL 快速部署脚本

set -e

echo "========================================"
echo "Fengyu PostgreSQL 部署脚本"
echo "========================================"
echo ""

# 检查 Docker 是否运行
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker 未运行，请先启动 Docker Desktop"
    echo ""
    echo "macOS: 打开 Docker Desktop 应用"
    echo "Linux: sudo systemctl start docker"
    exit 1
fi

echo "✅ Docker 运行正常"
echo ""

# 检查容器是否已存在
if docker ps -a --format '{{.Names}}' | grep -q "^fengyu-postgres$"; then
    echo "⚠️  容器 fengyu-postgres 已存在"
    read -p "是否删除并重新创建？(y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🗑️  停止并删除旧容器..."
        docker compose down -v
    else
        echo "🚀 启动现有容器..."
        docker compose start
        docker compose ps
        exit 0
    fi
fi

# 启动容器
echo "🚀 启动 PostgreSQL 容器..."
docker compose up -d

# 等待数据库就绪
echo ""
echo "⏳ 等待数据库启动..."
max_retries=30
retry_count=0

while [ $retry_count -lt $max_retries ]; do
    if docker exec fengyu-postgres pg_isready -U fengyu -d fengyu > /dev/null 2>&1; then
        echo "✅ 数据库已就绪"
        break
    fi
    retry_count=$((retry_count + 1))
    echo -n "."
    sleep 1
done

if [ $retry_count -eq $max_retries ]; then
    echo ""
    echo "❌ 数据库启动超时"
    echo "查看日志：docker compose logs postgres"
    exit 1
fi

echo ""
echo "========================================"
echo "✅ 部署完成"
echo "========================================"
echo ""
echo "📊 连接信息："
echo "  主机: localhost"
echo "  端口: 5432"
echo "  数据库: fengyu"
echo "  用户名: fengyu"
echo "  密码: fengyu123"
echo ""
echo "🔗 连接字符串："
echo "  postgresql://fengyu:fengyu123@localhost:5432/fengyu"
echo ""
echo "📝 下一步操作："
echo "  1. cd db"
echo "  2. cp .env.example .env"
echo "  3. npm install"
echo "  4. npm run db:push  # 开发环境快速同步 schema"
echo "  5. npm run db:studio  # 可视化管理数据"
echo ""
echo "🐳 Docker 命令："
echo "  查看日志: docker compose logs -f postgres"
echo "  停止数据库: docker compose stop"
echo "  重启数据库: docker compose restart"
echo "  删除容器: docker compose down"
echo "  删除所有数据: docker compose down -v"
echo ""
