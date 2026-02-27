---
name: wx-release-check
title: 微信小程序发版检查
description: |
  适用于发版检查工作流。检查所有待提交变更、部署已修改的云函数、
  执行冒烟测试、对比需求文档检查完成度、生成进度报告、最终提交并打 tag。
  当用户说"发版"、"检查一下能不能提交"、"上线前检查"、"release"时激活。
argument-hint: '[版本说明(可选)]'
user-invocable: true
disable-model-invocation: true
metadata:
  author: nvoyager
  title: 微信小程序发版检查
  version: 1.0.2
  description_zh: 从变更检查到提交打 tag 的完整发版工作流（通用版）
---

# 发版检查工作流

从变更检查到提交打 tag 的完整发版流程。适用于任何微信小程序 + CloudBase 项目。

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

将所有变更文件按以下类别分类：

```text
数据库变更：
  - db/schema/...
  - db/migrations/...

云函数变更（需要部署）：
  - <project>/cloudfunctions/<functionName>/...

前端页面变更：
  - <project>/miniprogram/pages/...
  - <project>/miniprogram/components/...

配置变更：
  - app.json / project.config.json / cloudbaserc.json

文档变更：
  - .42cog/spec/...
  - docs/...
```

> **发现路径**：通过 `git diff --stat` 输出自动识别项目名和云函数名，
> 无需硬编码路径。

### 1.3 关键检查点

- [ ] 是否有未执行的数据库迁移？（`db/migrations/` 有新文件但未 migrate）
- [ ] 是否有新路由未注册？（routes/ 有新导出但 index 未添加）
- [ ] 是否有新页面未注册？（pages/ 有新目录但 app.json 未添加）
- [ ] 是否有违反项目代码规范的文件？（如禁止 `.js` 则搜索 `.js` 文件）
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

从 Step 1.2 的变更分类中，提取所有 `cloudfunctions/` 路径下有变更的云函数：

```text
扫描规则：<project>/cloudfunctions/<functionName>/** 有变更 → 需要部署 <functionName>
```

列出所有需要部署的云函数及其所属项目。

### 3.2 部署

对每个有变更的云函数执行部署（使用 `cloudbase-deploy` 技能）：

```text
"部署 <functionName>"
```

### 3.3 环境变量检查

如果新增了依赖环境变量的代码：
1. `getFunctionConfig` 查看当前配置
2. 确认所需环境变量已存在
3. 如缺失，先读后合并再写入

---

## Step 4: 冒烟测试

### 4.1 识别需要测试的 action

从变更的云函数代码中提取所有修改过的 action（路由方法），形成测试清单：

```text
测试清单：
  <functionName>:
    - module.method1  → 描述
    - module.method2  → 描述
```

> **优先级**：认证相关 > 核心业务流程 > 查询接口 > 辅助接口

### 4.2 测试模板

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
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
  [PASS] <functionName> / module.method → { code: 0 }
  [PASS] <functionName> / module.method → { code: 0, data: [...] }
  [FAIL] <functionName> / module.method → { code: -400, message: "..." }
```

如有失败项，切换到 `debug-production` 流程排查。

---

## Step 5: 需求完成度检查

### 5.1 定位需求文档

在项目中查找需求文档（常见位置：`.42cog/spec/`、`docs/`、项目根目录的 `*.md`）。
如果项目 `CLAUDE.md` 中指定了需求文档路径，优先使用。

### 5.2 逐项对比

对需求文档中的功能点逐一检查实现状态：

```text
需求完成度报告：

[模块A] <文档名>
  [x] 功能点1 — 已实现（实现位置）
  [x] 功能点2 — 已实现（实现位置）
  [ ] 功能点3 — 待实现（说明原因）

[模块B] <文档名>
  [x] 功能点1 — 已实现
  [ ] 功能点2 — 未开始
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
- 创建版本 tag
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
  - <functionName>: 已部署 / 无变更
  - ...

冒烟测试：
  - X/Y 通过

需求完成度：
  - 模块A：XX%
  - 模块B：XX%

未完成项：
  - [功能名] — 原因/计划

Git：
  - commit: xxxxxxx
  - tag: vX.X.X
```
