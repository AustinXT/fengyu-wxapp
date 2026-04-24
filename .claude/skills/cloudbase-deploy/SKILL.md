---
name: cloudbase-deploy
title: CloudBase 云函数部署
description: >
  Deploys CloudBase cloud functions using the cloudbase-mcp MCP server
  (preferred),

  or tcb CLI as fallback when MCP is unavailable.

  Use when user says "部署云函数", "重新上传云函数", "部署 cloudfunctions", "部署到云服务",

  "使用 MCP 部署", "tcb 部署", or requests deploying / redeploying any cloud function.

  Also use for updating cloud function environment variables or invoking a
  function action to verify.
alwaysApply: false
metadata:
  author: nvoyager
  version: 1.1.0
  title: CloudBase 云函数部署
  description_zh: 使用 cloudbase-mcp 部署 CloudBase 云函数（首选），MCP 不可用时回退到 tcb CLI
---

# CloudBase 云函数部署指南

**优先**通过 `@cloudbase/cloudbase-mcp` MCP 服务器部署；MCP 不可用时回退到 `tcb` CLI。

## When to Use / 何时使用

- 用户修改云函数代码后需要重新部署
- 用户请求全量部署整个云函数目录
- 需要更新云函数的环境变量（数据库连接串、密钥等）
- 部署后需要调用某个 action 验证是否生效

**不适用于：**
- CloudRun 容器服务
- 仅修改小程序前端代码（无需部署云函数）

---

## 第一步：探查项目结构

在部署前先了解项目的云函数布局：

```
# 云函数通常位于以下位置之一：
cloudfunctions/          # 微信小程序默认
functions/               # 自定义目录
```

关键信息：
- **functionRootPath**：云函数目录的**父目录**绝对路径（不是函数本身的目录）
- **envId**：CloudBase 环境 ID，格式如 `cloud1-xxxxxxxx`，从项目配置文件（如 `cloudbaserc.yml`）或 MCP 配置中读取
- **functionName**：函数子目录名称

---

## 部署工作流

### 模式 A：全量部署（所有云函数）

触发词：`"部署 cloudfunctions"` / `"部署所有云函数"` / `"全量部署"`

```
1. 列出 cloudfunctions/ 下所有子目录（每个子目录是一个云函数）
2. 对每个函数依次调用 updateFunctionCode（已存在）或 createFunction（首次）
3. 汇报每个函数的部署结果
```

**MCP 工具调用示例（更新已有函数代码）：**
```json
{
  "tool": "updateFunctionCode",
  "envId": "<cloudbase-env-id>",
  "functionName": "<function-name>",
  "functionRootPath": "/absolute/path/to/cloudfunctions"
}
```

### 模式 B：仅部署单个函数

触发词：`"重新上传云函数"` / `"部署 <function-name>"` / `"重新部署"`

```
1. 确认目标函数名称（询问用户或根据上下文推断）
2. 调用 updateFunctionCode 仅部署该函数
3. 确认部署成功
```

### 模式 C：调用 action 验证（部署后冒烟测试）

触发词：`"调用 <action> 验证"` / `"部署后测试一下"` / `"调用 <functionName> 的 <action>"`

```
1. 部署完成后，调用 invokeFunction（或 callFunction）
2. 传入 action 参数触发对应逻辑
3. 检查返回值 { code, message, data } 确认无错误
```

**MCP 工具调用示例：**
```json
{
  "tool": "invokeFunction",
  "envId": "<cloudbase-env-id>",
  "functionName": "<function-name>",
  "params": { "action": "<action-name>" }
}
```

---

## 环境变量更新

**核心原则：先读后合并，绝不直接覆盖**

```
1. 读取现有环境变量：getFunctionConfig → envVariables
2. 将新 key-value 合并到现有列表
3. 调用 updateFunctionConfig 写入完整合并后的列表
```

常见环境变量示例（数据库连接场景）：
```
# 示例格式，替换为实际值，不要硬编码在源代码中
DATABASE_URL=postgresql://user:password@host:5432/dbname
DB_HOST=your-db-host
DB_PORT=5432
DB_NAME=your-database
DB_USER=your-username
DB_PASSWORD=your-password
```

**错误示例（避免）：** 直接 `updateFunctionConfig` 只传新变量 → 会清空其他已有变量

---

## 函数代码规范

云函数入口（`index.js` / `index.ts`）必须导出 `main`：

```js
exports.main = async (event, context) => {
  try {
    // 业务逻辑
    return { code: 0, message: 'success', data: result }
  } catch (err) {
    return { code: -1, message: err.message, data: null }
  }
}
```

- **无需本地编译**：上传 `.ts` 源文件时，CloudBase 会在服务端自动执行 `tsc`
- `package.json` 中的依赖会在服务端自动 `npm install`，无需上传 `node_modules`

---

## 运行时说明

| 运行时 | 说明 |
|--------|------|
| `Nodejs18.15` | 默认推荐，最新稳定版 |
| `Nodejs16.13` | 兼容旧项目 |

**注意：** 函数创建后运行时**无法修改**。如需变更，必须删除重建。

---

## MCP 工具速查

| 操作 | MCP 工具 | 必填参数 |
|------|----------|----------|
| 更新函数代码 | `updateFunctionCode` | `envId`, `functionName`, `functionRootPath` |
| 创建新函数 | `createFunction` | `envId`, `functionName`, `functionRootPath`, `runtime` |
| 更新配置/环境变量 | `updateFunctionConfig` | `envId`, `functionName`, `envVariables` |
| 读取函数配置 | `getFunctionConfig` | `envId`, `functionName` |
| 调用函数 | `invokeFunction` | `envId`, `functionName`, `params` |
| 查询日志列表 | `getFunctionLogs` | `envId`, `functionName`, `startTime`, `endTime` |
| 查询日志详情 | `getFunctionLogDetail` | `envId`, `requestId` |

---

## Plan B：tcb CLI 备用部署

**触发条件：** MCP 工具不可用（`可用的 MCP 服务器中没有 cloudbase`）时使用。

### 前置条件

```bash
# 安装 CLI（如未安装）
npm i -g @cloudbase/cli

# 步骤 1：登录（两种方式二选一）
# 方式 A：微信扫码登录
tcb logout && tcb login

# 方式 B：腾讯云 API 密钥登录（用 .env 中的 TENCENTCLOUD_SECRETID/KEY）
# ⚠️ 注意：必须先 logout，仅设置环境变量不会覆盖已缓存的 token！
tcb logout && tcb login -k --apiKeyId <SECRETID> --apiKey <SECRETKEY>

# 步骤 2：验证目标环境可见（若不在列表中，说明当前账号无权限）
tcb env list
# 确认目标 envId 出现在列表中，再执行部署；否则换账号重试
```

### 首次部署（函数不存在）

```bash
# 带绝对路径，最稳健
tcb fn deploy <functionName> \
  --envId <envId> \
  --dir /absolute/path/to/cloudfunctions/<functionName> \
  --force

# 从项目目录，用 echo 跳过交互确认
cd /path/to/miniprogram-root
echo | tcb fn deploy <functionName> --envId <envId> --dir cloudfunctions/<functionName> --force
```

### 迭代更新代码（函数已存在）

```bash
# 比 fn deploy 更快，不重建函数配置
# ⚠️ tcb CLI 3.x 的 fn code update 不支持 --envId / --env-id 参数
# envId 从项目 cloudbaserc.json 读取，需先 cd 到含该配置的目录
cd /path/to/miniprogram-root   # 该目录下应有 cloudbaserc.json 指定 envId
tcb fn code update <functionName>
```

> **首次用 `fn deploy`，后续迭代用 `fn code update`**
>
> 如果当前目录没有 `cloudbaserc.json` 或 envId 不对，先新建/修改再部署；不要想通过命令行参数覆盖。

### 常用辅助命令

```bash
# 列出环境中所有函数
tcb fn list -e <envId>

# 查看函数日志
tcb fn log <functionName> --envId <envId>
```

### tcb CLI 特有问题

| 问题 | 原因 | 解决方法 |
|------|------|---------|
| 云端 `npm install` 失败，函数状态 "Creation failed" | 网络或依赖兼容性问题 | 本地先 `npm install`，在 `cloudbaserc.json` 中设置 `autoInstallDependencies: false`，连同 `node_modules` 一起上传 |
| `Environment not found` | 当前会话无法看到目标环境（账号或权限问题） | 先 `tcb env list` 确认环境是否可见；不可见则 `tcb logout && tcb login` 切换账号重新登录 |
| 设置 `TENCENTCLOUD_SECRETID` 环境变量后仍报 "not found" | 环境变量不会覆盖已缓存的 session token | 必须先 `tcb logout`，再 `tcb login -k --apiKeyId <id> --apiKey <key>` 显式登录 |
| 部署到了错误的环境 | 未指定 `--envId` 时用了 CLI 默认环境 | 始终显式传 `--envId <envId>`（`fn code update` 除外，见下方） |
| `tcb fn code update` 报 `unknown option --envId` / `--env-id` | tcb CLI 3.x 的 `fn code update` 子命令不接受 envId 参数 | envId 从当前目录的 `cloudbaserc.json` 读取；先 `cd` 到正确项目目录，确认其中 envId 正确后再执行 |
| `env list` 能看到目标环境但 `fn list` 报 `Environment not found`（同一账号） | `~/.cloudbase-cli/auth.json` 优先级高于环境变量；不同子命令对 credentials 的读取方式不一致，导致走到了旧 session | 切换账号时按顺序执行：①`unset TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY` ②`tcb logout` ③`tcb login -k --apiKeyId <id> --apiKey <key>`（让 auth.json 写入目标账号）|
| 并行部署两个账号互相覆盖 session | `~/.cloudbase-cli/auth.json` 是全局单例 | 并行执行时用串行 login → 完成一端 → 再 logout → login 另一端；或在不同机器/容器运行 |

---

## 常见错误排查

| 错误 | 原因 | 解决方法 |
|------|------|---------|
| `ETIMEOUT` / `ECONNREFUSED` | 数据库 IP/端口不可达 | 检查 `DB_HOST` 和 `DB_PORT` 环境变量，确认数据库安全组已放通云函数 IP |
| `ECONNRESET` / `PROTOCOL_CONNECTION_LOST` | 数据库连接被中断 | 检查数据库连接超时设置和连接池配置 |
| `Authentication failed` / `Login failed` | 数据库凭证错误 | 检查 `DB_USER` 和 `DB_PASSWORD` 环境变量 |
| `errCode: -601034 没有权限` | 跨环境调用未授权 | 在微信云开发控制台开启「环境共享」 |
| 函数不存在 | 首次部署使用了 `updateFunctionCode` | 改用 `createFunction` 初始化 |

---

## 查询日志（调试用）

```
1. getFunctionLogs：获取日志列表和 RequestId（时间范围最大 1 天）
2. getFunctionLogDetail：传入 RequestId 获取完整日志内容
```

---

## 环境变量安全守卫（项目特化）

### 必须保护的环境变量

| 云函数 | 变量名 | 用途 |
|--------|--------|------|
| clientApi | PG_CONNECTION_STRING | PostgreSQL 连接 |
| clientApi | TMAP_KEY | 腾讯地图 API Key |
| clientApi | TMAP_SECRET | 腾讯地图签名密钥 |
| staffApi | PG_CONNECTION_STRING | PostgreSQL 连接 |
| staffApi | CLIENT_SECRET | 内部接口密钥 |
| staffApi | WXACODE_ENV_VERSION | 小程序码环境版本 |

### 部署后强制验证

每次部署完成后必须：
1. 调用 `getFunctionConfig` 检查上表所有变量是否存在且非空
2. 调用 `auth.login` 冒烟测试验证数据库连接正常
3. 若部署的是 clientApi，额外调用 `store.list` 验证 TMAP 相关功能

### 禁令

**永远不对已有函数使用 `tcb fn deploy --force`**，改用 `tcb fn code update`。
`--force` 会重置函数配置（含环境变量），这是 TMAP_KEY 反复丢失的根因。
