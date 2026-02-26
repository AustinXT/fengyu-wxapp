---
name: release-check
description: |
  适用于发版检查工作流。检查所有待提交变更、部署已修改的云函数、
  执行冒烟测试、对比需求文档检查完成度、生成进度报告、最终提交并打 tag。
  当用户说"发版"、"检查一下能不能提交"、"上线前检查"、"release"时激活。
argument-hint: '[版本说明(可选)]'
user-invocable: true
disable-model-invocation: true
metadata:
  author: fengyu
  version: 1.0.0
  title: 发版检查
  description_zh: 从变更检查到提交打 tag 的完整发版工作流
---

# 发版检查工作流

从变更检查到提交打 tag 的完整发版流程。

## 何时使用

- 完成一轮开发后准备提交代码
- 上线前需要整体检查
- 用户说"发版"、"release"、"检查能不能提交"

## 使用方法

```bash
/release-check
/release-check v2.1.0 预约功能上线
```

## 不适用

- 开发新功能（用 `implement-feature` / `implement-api`）
- 排查线上问题（用 `debug-production`）
- 仅提交代码不需要检查（用 `git-commit`）

---

## Step 1: 变更盘点

### 1.1 查看 Git 状态

```bash
git status
git diff --stat
git diff --cached --stat
```

### 1.2 分类变更

将所有变更文件分类：

```text
数据库变更：
  - db/schema/xxx.ts
  - db/migrations/xxxx.sql

云函数变更（需要部署）：
  - fengyu-client/cloudfunctions/clientApi/...
  - fengyu-staff/cloudfunctions/staffApi/...

前端页面变更：
  - fengyu-client/miniprogram/pages/...
  - fengyu-staff/miniprogram/pages/...

配置变更：
  - app.json / project.config.json / cloudbaserc.json

文档变更：
  - .42cog/spec/...
  - notes/...
```

### 1.3 关键检查点

- [ ] 是否有未执行的数据库迁移？（`db/migrations/` 有新文件但未 migrate）
- [ ] 是否有新路由未注册？（routes/ 有新导出但 index.js 未添加）
- [ ] 是否有新页面未注册？（pages/ 有新目录但 app.json 未添加）
- [ ] 是否有 `.js` 文件出现在 miniprogram/？（严禁，仅允许 `.ts`）
- [ ] `cloudbaserc.json` 中 `installDependency` 是否为 `false`？（必须为 false，由云端自动安装依赖）
- [ ] `.cloudbaseignore` 是否排除测试文件（`__tests__/`、`*.test.*`）但包含 `node_modules`？
- [ ] 是否有遗留的 `console.log` 调试语句？（搜索 `console.log` 排除结构化日志）

---

## Step 2: 数据库迁移验证

### 2.1 检查迁移状态

```bash
cd db && ls migrations/
```

### 2.2 确认迁移已执行

检查 `db/migrations/meta/_journal.json`，确认所有迁移记录存在。

如有未执行的迁移：
```bash
cd db && npm run db:migrate
```

---

## Step 3: 云函数部署

### 3.1 识别需要部署的云函数

检查变更文件列表，确定哪些云函数有代码变更：

| 变更路径 | 需要部署的云函数 |
|---|---|
| `fengyu-client/cloudfunctions/clientApi/**` | clientApi |
| `fengyu-staff/cloudfunctions/staffApi/**` | staffApi |

### 3.2 部署

对每个有变更的云函数执行部署（使用 `cloudbase-deploy` 技能）：

```text
"部署 clientApi"
"部署 staffApi"
```

### 3.3 环境变量检查

如果新增了依赖环境变量的代码：
1. `getFunctionConfig` 查看当前配置
2. 确认所需环境变量已存在
3. 如缺失，先读后合并再写入

---

## Step 4: 冒烟测试

### 4.1 测试关键路径

对每个修改过的 API action 执行 invokeFunction 验证：

**clientApi 核心路径：**
```text
auth.login          → 用户登录
product.categories  → 商品分类
product.spuList     → 商品列表
order.create        → 创建订单（复杂，慎测）
```

**staffApi 核心路径：**
```text
auth.login          → 员工登录
store.list          → 门店列表
staff.list          → 员工列表
order.list          → 订单列表
```

### 4.2 测试模板

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "clientApi",
  "params": {
    "action": "module.method",
    "payload": {}
  }
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

### 4.3 记录测试结果

```text
测试结果：
  [PASS] auth.login → { code: 0 }
  [PASS] product.categories → { code: 0, data: [...] }
  [FAIL] order.create → { code: -400, message: "..." }
```

如有失败项，切换到 `debug-production` 流程排查。

---

## Step 5: 需求完成度检查

### 5.1 读取需求文档

读取 `.42cog/spec/` 下对应的需求文档。

### 5.2 逐项对比

对需求文档中的功能点逐一检查实现状态：

```text
需求完成度报告：

[客户端] client_pr.md
  [x] 服务/产品浏览 — 已实现（shop 页面 + product API）
  [x] 购物车 — 已实现（cart 页面 + utils/cart.ts）
  [x] 下单支付 — 已实现（checkout 页面 + order API）
  [ ] 微信支付回调 — 待实现（当前为 Mock）
  [x] 预约 — 已实现（appointment 页面 + API）

[员工端] staff_pr.md
  [x] 订单管理 — 已实现
  [ ] 营业报表 — 未开始

[后端] backend_pr.md
  [x] 订单流水号生成 — 已实现
  [ ] 支付通知回调 — 待实现
```

### 5.3 标注差距

明确标注：
- **已完成** 的功能
- **部分完成** 的功能（说明缺什么）
- **未开始** 的功能
- **不在本次范围** 的功能

---

## Step 6: 提交与打 Tag

### 6.1 确认提交范围

向用户展示将要提交的变更摘要和需求完成度报告，等待确认。

### 6.2 执行提交

确认后使用 `git-commit` 技能提交：

```text
触发词："提交代码" 或 "/git-commit"
```

`git-commit` 技能会自动：
- 执行 `git add`（添加相关文件）
- 生成智能提交信息
- 创建 42 进制版本 tag
- 推送代码和 tag 到远程

---

## 输出：发版报告

```text
=== 发版报告 ===

日期：YYYY-MM-DD
版本：vX.X.X

变更摘要：
  - [feat] 功能描述
  - [fix] 修复描述

部署状态：
  - clientApi: 已部署
  - staffApi: 已部署 / 无变更

冒烟测试：
  - X/Y 通过

需求完成度：
  - 客户端：XX%
  - 员工端：XX%
  - 后端：XX%

未完成项：
  - [功能名] — 原因/计划

Git：
  - commit: xxxxxxx
  - tag: vX.X.X
```
