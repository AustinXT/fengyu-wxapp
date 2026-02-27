---
name: wx-debug-production
description: |
  适用于线上排障工作流。从错误现象出发，通过 MCP 工具查询云函数日志、分析错误堆栈、
  定位根因、修复代码、重新部署、回归验证的完整闭环。
  当用户说"线上报错了"、"接口调用失败"、"排查一下这个错误"时激活。
argument-hint: '[错误描述或 action 名称]'
user-invocable: true
metadata:
  author: nvoyager
  title: 微信小程序线上排障
  version: 1.0.1
  description_zh: 从错误现象到修复验证的线上问题排查完整闭环
---

# 线上排障工作流

从错误现象到修复验证的完整排查闭环。适用于任何基于微信小程序 + 腾讯云开发（CloudBase）的项目。

## 何时使用

- 云函数接口返回错误（`code !== 0`）
- 小程序端调用失败或数据异常
- 用户反馈线上功能不正常
- 需要查看云函数运行日志

## 使用方法

```bash
/debug-production order.create 返回 -400
/debug-production <functionName> 登录接口报错
```

## 不适用

- 开发新功能（用 `implement-feature` / `implement-api`）
- 发版前整体检查（用 `release-check`）
- 本地开发调试（用微信开发者工具）

---

## Step 1: 收集错误上下文

### 1.1 明确错误信息

向用户收集：

```text
错误来源：[ ] 小程序端报错  [ ] 云函数日志  [ ] 用户反馈  [ ] 其他
涉及 Action：module.method
错误现象：[具体描述]
错误码：[code 值，如 -1, -400, -401, -403]
错误消息：[message 内容]
复现条件：[何时/谁操作时出现]
```

### 1.2 定位代码位置

根据 action 名称定位源码文件。云函数通常位于 `cloudfunctions/<functionName>/` 目录下，
路由文件通常按模块组织在 `routes/` 目录中。

定位步骤：

1. 从 action 名称中提取模块前缀（如 `order.create` 的模块为 `order`）
2. 在云函数目录中查找对应路由文件（如 `routes/order.js` 或 `routes/order.ts`）
3. 在路由文件中定位具体方法

阅读对应路由文件和中间件代码。

---

## Step 2: 查询云函数日志

### 2.1 获取日志列表

通过 MCP 工具查询最近的函数日志：

```json
{
  "tool": "getFunctionLogs",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "startTime": "错误发生前的时间戳",
  "endTime": "当前时间戳"
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

**时间范围建议：** 取错误发生时间前后 10 分钟，最大范围 1 天。

### 2.2 获取日志详情

从日志列表中找到相关 RequestId，获取完整日志：

```json
{
  "tool": "getFunctionLogDetail",
  "envId": "<ENV_ID>",
  "requestId": "从 Step 2.1 获取的 RequestId"
}
```

### 2.3 分析日志

重点关注：
- `[action] Error:` 开头的错误日志
- SQL 查询错误（`syntax error`、`relation does not exist`、`column not found`）
- 连接错误（`ETIMEOUT`、`ECONNREFUSED`、`ECONNRESET`）
- 权限错误（`UNAUTHORIZED`、`PHONE_REQUIRED`、`PERMISSION_DENIED`）
- 参数错误（`INVALID_PARAMS`、`undefined`、`null`）

---

## Step 3: 根因分析

### 3.0 首要排查：是否已部署？

> **最高频误判：代码已修改但行为未变 = 未重新部署云函数**
>
> 在深入日志和代码分析前，先确认本次修改是否已部署到云端。
> 使用 `getFunctionDetail` 查看最后部署时间，或直接重新部署一次排除此因素。

### 3.1 常见错误模式

| 错误类型 | 典型表现 | 常见根因 |
|---|---|---|
| **SQL 语法错误** | `syntax error at or near` | 拼写错误、缺少引号、参数占位符错误 |
| **表/列不存在** | `relation "xxx" does not exist` | Schema 迁移未执行、列名拼写错误 |
| **连接超时** | `ETIMEOUT`、`ECONNREFUSED` | 数据库地址错误、网络不通、连接池耗尽 |
| **认证失败** | `Login failed`、连接被拒 | 环境变量中密码错误或缺失 |
| **权限不足** | `code: -401` / `-403` | 用户未绑定手机号、角色权限不匹配 |
| **参数缺失** | `code: -400` | 前端传参不完整、字段名不匹配 |
| **并发冲突** | 序号重复、次数超扣 | 锁机制未生效、原子扣减逻辑错误 |
| **外部数据源查询失败** | 连接错误、字段不匹配 | 外部数据库结构变更、连接配置过期 |
| **部署版本不一致** | 代码已修改但行为未变 | 云函数未重新部署 |

### 3.2 检查关联文件

根据错误类型检查：

- **数据库问题** → 检查数据库 schema 定义和迁移文件
- **环境变量问题** → 通过 MCP `getFunctionConfig` 查看
- **认证问题** → 检查认证中间件（如 `middleware/auth.*`）
- **参数问题** → 检查参数校验中间件和对应路由处理函数
- **外部数据源问题** → 参照项目文档中的外部数据源说明

---

## Step 4: 修复代码

### 4.1 编写修复

根据根因修改代码，注意：

- **遵守项目既有的架构规范和约束**（只读数据源不可写、原子操作、幂等性等）
- **保持向后兼容**（不破坏现有前端调用）
- **修复后增加防御性检查**（避免同类问题再次出现）

### 4.2 本地验证

检查代码修改：
- JavaScript/TypeScript 语法无误
- SQL 查询参数占位符正确（`$1, $2` 顺序一致）
- 新增/修改的导出函数名与路由表一致

---

## Step 5: 部署修复

### 5.1 部署云函数

使用 `cloudbase-deploy` 技能：

```text
"部署 <functionName>"
```

### 5.2 环境变量修复（如需要）

如果问题是环境变量导致：

1. `getFunctionConfig` 获取当前完整配置
2. 修改/添加目标变量
3. `updateFunctionConfig` 写入合并后的完整列表

---

## Step 6: 回归验证

### 6.1 重现原始错误场景

使用 `invokeFunction` 模拟出错时的调用：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "params": {
    "action": "<moduleName>.<methodName>",
    "payload": { /* 原始出错参数 */ }
  }
}
```

### 6.2 验证修复结果

- [ ] 原始错误不再复现
- [ ] 返回 `{ code: 0 }` 和正确数据
- [ ] 相关联的其他接口未受影响
- [ ] 查看新日志确认无报错

### 6.3 边界测试

- 缺少参数的调用 → 应返回 `code: -400`
- 无权限的调用 → 应返回 `code: -401` 或 `-403`
- 正常参数的调用 → 应返回 `code: 0`

---

## 输出报告

```text
问题描述：[错误现象]
根因分析：[根本原因]
修复方案：[修改了什么]
修改文件：
  - path/to/file（修改描述）
部署状态：已部署
验证结果：通过
```
