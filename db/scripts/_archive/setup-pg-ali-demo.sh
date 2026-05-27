#!/bin/bash
# PostgreSQL 安装脚本 - ali-demo 服务器
# 数据库: fengyu_wxapp
# 用户: fengyu
# 密码: fengyu123

set -e

echo "=== PostgreSQL 自动化安装 ==="

# 检测操作系统
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "无法检测操作系统"
    exit 1
fi

# 安装 PostgreSQL
case $OS in
    ubuntu|debian)
        echo "检测到 Ubuntu/Debian 系统"
        apt-get update
        apt-get install -y postgresql postgresql-contrib
        ;;
    centos|rhel)
        echo "检测到 CentOS/RHEL 系统"
        yum install -y postgresql-server postgresql-contrib
        postgresql-setup initdb
        ;;
    alinux)
        echo "检测到 Alibaba Cloud Linux"
        yum install -y postgresql-server postgresql-contrib
        postgresql-setup initdb
        ;;
    *)
        echo "不支持的操作系统: $OS"
        exit 1
        ;;
esac

# 启动 PostgreSQL 服务
systemctl start postgresql
systemctl enable postgresql

echo "✓ PostgreSQL 安装完成"

# 创建数据库和用户
echo "=== 创建数据库和用户 ==="
sudo -u postgres psql << 'EOF'
-- 创建用户
CREATE USER fengyu WITH PASSWORD 'fengyu123';

-- 创建数据库
CREATE DATABASE fengyu_wxapp OWNER fengyu;

-- 授权
GRANT ALL PRIVILEGES ON DATABASE fengyu_wxapp TO fengyu;

-- 连接到数据库并授权 schema
\c fengyu_wxapp
GRANT ALL ON SCHEMA public TO fengyu;
EOF

echo "✓ 数据库和用户创建完成"

# 配置远程访问
echo "=== 配置远程访问 ==="
PG_VERSION=$(psql --version | grep -oP '\d+' | head -1)
PG_CONF="/etc/postgresql/$PG_VERSION/main/postgresql.conf"
PG_HBA="/etc/postgresql/$PG_VERSION/main/pg_hba.conf"

# 修改监听地址
if [ -f "$PG_CONF" ]; then
    sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" "$PG_CONF"
    echo "✓ 已配置监听所有地址"
else
    echo "警告: 未找到 postgresql.conf，请手动配置"
fi

# 允许密码认证
if [ -f "$PG_HBA" ]; then
    echo "host    all             all             0.0.0.0/0               md5" >> "$PG_HBA"
    echo "✓ 已配置远程访问权限"
else
    echo "警告: 未找到 pg_hba.conf，请手动配置"
fi

# 重启 PostgreSQL
systemctl restart postgresql

echo ""
echo "=== 安装完成 ==="
echo "数据库连接信息:"
echo "  主机: $(curl -s ifconfig.me || echo 'ali-demo服务器IP')"
echo "  端口: 5432"
echo "  数据库: fengyu_wxapp"
echo "  用户名: fengyu"
echo "  密码: fengyu123"
echo ""
echo "连接字符串:"
echo "  postgresql://fengyu:fengyu123@$(curl -s ifconfig.me || echo 'ali-demo服务器IP'):5432/fengyu_wxapp"
echo ""
echo "下一步:"
echo "1. 配置防火墙开放 5432 端口"
echo "2. 初始化数据库表结构（运行 db/init.sh）"
echo "3. 配置云函数环境变量"
