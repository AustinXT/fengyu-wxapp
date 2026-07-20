# fengyu-client 脚本

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `configure-env.sh` | 通过腾讯云 SDK 更新 clientApi 云函数的环境变量 |
| `update-env.js` | `configure-env.sh` 调用的 Node.js 实现（勿单独运行） |

## 使用方法

```bash
# 1. 设置腾讯云凭证（从 ~/.zshrc 或控制台获取）
export TENCENTCLOUD_SECRETID="your-secret-id"
export TENCENTCLOUD_SECRETKEY="your-secret-key"

# 2. 运行配置脚本（在 fengyu-client/ 目录下执行）
cd fengyu-client
bash scripts/configure-env.sh
```

## 需要配置的环境变量

| 变量名 | 说明 |
|--------|------|
| `PG_CONNECTION_STRING` | PostgreSQL 连接串（生产 fengyu-prod / 测试·开发 ali-demo） |
| `MSSQL_CONNECTION_STRING` | SQL Server 连接串（WorkFine 只读） |

实际值存储在 `fengyu-client/.env`（已加入 .gitignore，不提交）。

## 手动配置（不用脚本）

直接在 CloudBase 控制台操作：
1. 进入 https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf
2. 找到 `clientApi` → 配置 → 环境变量 → 编辑

## 权限要求

腾讯云子账号需要 `QcloudSCFFullAccess` 或以下最小权限：
- `scf:UpdateFunctionConfiguration`
- `scf:GetFunction`
