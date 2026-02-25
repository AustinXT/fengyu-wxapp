#!/bin/bash
# 数据库表结构初始化脚本

# 提示输入服务器 IP
read -p "请输入 ali-demo 服务器 IP: " SERVER_IP

# 设置数据库连接串
export DATABASE_URL="postgresql://fengyu:fengyu123@$SERVER_IP:5432/fengyu_wxapp"

echo "正在连接到: $DATABASE_URL"

# 安装依赖
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
fi

# 推送表结构
echo "推送表结构到数据库..."
npx drizzle-kit push

echo "✓ 表结构初始化完成"
echo ""
echo "验证表结构:"
echo "PGPASSWORD=fengyu123 psql -h $SERVER_IP -U fengyu -d fengyu_wxapp -c '\dt'"
