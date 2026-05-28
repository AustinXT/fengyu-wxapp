---
name: dev-loop
description: |
  自驱式开发循环 prompt 模板。预设 QA 优化、功能开发、重构、Bug 修复
  四种场景的 /loop 指令，减少每次手写 loop prompt 的成本。
  当用户说"开循环"、"loop 模板"、"自动优化"、"自动开发"时激活。
argument-hint: '<模式> <范围>，如: qa staff, feature 预约, refactor admin, fix client'
user-invocable: true
metadata:
  title: 自驱式开发循环
  description_zh: 预设 QA/功能/重构/修复四种 /loop prompt 模板
  author: nvoyager
  version: 1.0.0
  license: MIT
---

# 自驱式开发循环

为 `/loop` 命令预设高效的 prompt 模板，覆盖日常开发的 4 种主要场景。

## 使用方法

```bash
/dev-loop qa staff          # 员工端 QA 优化循环
/dev-loop feature 预约       # 预约功能开发循环
/dev-loop refactor admin    # 管理后台重构循环
/dev-loop fix client        # 客户端 Bug 修复循环
```

## 不适用

- 一次性任务（不需要循环）
- 需求分析/设计阶段 → `meeting-to-spec` / `product-requirements`
- 枚举/字段变更 → `wx-change-propagation`

---

## 模板 1: QA 优化循环

**场景**：对已有代码进行持续质量改进——找 gap、修一个、测一下、报告。

**用法**：`/dev-loop qa <scope>`，scope = `staff` | `client` | `admin` | `staffApi` | `clientApi`

**生成的 /loop 指令**：

```
/loop 30m 读取 .42cog/pm/<对应端>.pr.spec.md 和 <scope> 目录的代码。
找出一个可改进点（类型：bug / 缺失功能 / 代码质量 / 性能 / 错误处理）。
优先级：bug > 缺失功能 > 错误处理 > 代码质量 > 性能。
修复它。如果是 admin 端，运行 bun run test 确认通过。
如果是云函数端，检查 SQL 参数化。
如果是小程序端，检查 TypeScript 无编译错误。
输出: [轮次N] 改进类型 | 文件 | 改动摘要 | 测试结果
```

**scope 映射表**：

| scope | spec 文件 | 代码目录 | 测试命令 |
|-------|----------|---------|---------|
| `staff` | `staff.pr.spec.md` | `fengyu-staff/miniprogram/` | TypeScript 编译 |
| `client` | `client.pr.spec.md` | `fengyu-client/miniprogram/` | TypeScript 编译 |
| `admin` | `admin.pr.spec.md` | `fengyu-admin/src/` | `cd fengyu-admin && bun run test` |
| `staffApi` | `backend.pr.spec.md` | `fengyu-staff/cloudfunctions/staffApi/` | SQL 参数化检查 |
| `clientApi` | `backend.pr.spec.md` | `fengyu-client/cloudfunctions/clientApi/` | SQL 参数化检查 |

---

## 模板 2: 功能开发循环

**场景**：按 spec 逐步实现功能——每轮完成一个 action 或一个页面。

**用法**：`/dev-loop feature <功能关键词>`

**生成的 /loop 指令**：

```
/loop 30m 读取 .42cog/pm/ 下与"<功能关键词>"相关的 spec 章节。
列出该功能尚未实现的 action/页面清单。
选择一个优先级最高的未实现项。
按 wx-coding 的 §7/§8 checklist 实现它：
  - 如需 schema 变更 → db:generate + db:migrate
  - 云函数 → 写 handler + 注册路由
  - 前端 → 写 TS/WXML/WXSS + 注册页面
完成后输出: [轮次N] 实现项 | 修改文件列表 | 剩余未实现项数
```

---

## 模板 3: 重构循环

**场景**：对指定范围做渐进式重构——每轮找一个改进点。

**用法**：`/dev-loop refactor <scope>`

**生成的 /loop 指令**：

```
/loop 30m 扫描 <scope> 目录代码，找出一个重构机会：
  类型：重复代码 / 过长函数 / 不一致的命名 / 缺失类型 / 废弃引用 / 性能问题
选择影响最大且风险最低的一项执行。
如果是 admin 端，重构后运行 bun run test 确认无回归。
如果涉及枚举/字段变更，先跑 /wx-change-propagation 的 Phase 2 全量扫描。
输出: [轮次N] 重构类型 | 文件 | 变更摘要 | 测试结果
```

---

## 模板 4: Bug 修复循环

**场景**：逐个修复已知问题列表，或扫描代码发现潜在 bug。

**用法**：`/dev-loop fix <scope>`

**生成的 /loop 指令**：

```
/loop 20m 扫描 <scope> 目录代码，查找潜在 bug：
  类型：空值未处理 / 异步竞态 / 类型不安全 / 边界条件 / 状态不一致
选择最严重的一个修复。
验证修复：
  - admin: bun run test
  - 云函数: 检查 SQL + 错误处理
  - 小程序: TypeScript 编译
输出: [轮次N] Bug 类型 | 文件:行号 | 修复摘要 | 验证结果
```

---

## 自定义参数

所有模板支持以下可选参数调整：

| 参数 | 默认 | 说明 |
|------|------|------|
| 间隔 | 30m（fix 为 20m） | `/loop` 的循环间隔 |
| 优先级 | 按模板定义 | 可覆盖优先级排序 |
| 排除 | 无 | 可指定排除的文件/目录 |

**自定义示例**：

```
/dev-loop qa admin --interval 15m --exclude e2e
/dev-loop feature 退款 --priority "后端优先"
```

---

## 工作流组合

常见的 loop 组合顺序：

```text
1. /dev-loop feature <功能>    # 先实现功能
2. /dev-loop qa <scope>        # 再做质量优化
3. /dev-loop fix <scope>       # 最后修 bug
4. /security-review <scope>    # 安全审查
5. /wx-release-check           # 发版检查
```
