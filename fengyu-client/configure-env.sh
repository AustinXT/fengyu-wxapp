#!/bin/bash
# 配置云函数环境变量脚本

set -e

echo "=== CloudBase 云函数环境变量配置 ==="
echo ""
echo "此脚本将配置 clientApi 云函数的环境变量"
echo ""

# 检查腾讯云凭证
if [ -z "$TENCENTCLOUD_SECRETID" ] || [ -z "$TENCENTCLOUD_SECRETKEY" ]; then
    echo "错误: 未找到腾讯云凭证环境变量"
    echo ""
    echo "请设置环境变量:"
    echo "  export TENCENTCLOUD_SECRETID='your-secret-id'"
    echo "  export TENCENTCLOUD_SECRETKEY='your-secret-key'"
    echo ""
    echo "获取方式:"
    echo "  1. 访问 https://console.cloud.tencent.com/cam/capi"
    echo "  2. 登录腾讯云账号"
    echo "  3. 创建或查看 API 密钥"
    echo ""
    echo "或者直接运行（替换为你的密钥）:"
    echo "  TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx bash $0"
    exit 1
fi

echo "✓ 腾讯云凭证已配置"
echo ""

# 检查 Node.js 和依赖
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js"
    exit 1
fi

if [ ! -d "node_modules/tencentcloud-sdk-nodejs-scf" ]; then
    echo "安装依赖..."
    npm install tencentcloud-sdk-nodejs-scf --save-dev
fi

echo "✓ 依赖已准备"
echo ""

# 执行配置
echo "开始配置环境变量..."
echo ""

node update-env.js

echo ""
echo "=== 配置完成 ==="
echo ""
echo "下一步:"
echo "1. 在 CloudBase 控制台验证环境变量"
echo "   https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf"
echo ""
echo "2. 测试云函数调用"
echo "   使用 test_cases.json 中的测试用例"
