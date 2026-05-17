# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

凤御双美容院微信小程序生态系统（monorepo）。各子项目详见其目录下的 CLAUDE.md。

## 技术栈

| 层级 | 技术 |
|------|------|
| 小程序前端 | 微信小程序原生 + Vant Weapp 1.x + TypeScript |
| 云函数 | CloudBase 云函数 (Node.js 18, 纯 JS) |
| 管理后台 | Next.js 15 (App Router) + Tailwind CSS v4 |
| 数据库 | PostgreSQL（自托管，业务主库）|
| ORM | Drizzle ORM（仅 db/ 目录，云函数用原生 SQL） |

## 架构概览

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ fengyu-     │  │ fengyu-     │  │ fengyu-     │
│ client      │  │ staff       │  │ admin       │
│ miniprogram │  │ miniprogram │  │ (Next.js)   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
  wx.cloud.callFunction          Drizzle ORM
       │                │                │
┌──────▼──────┐  ┌──────▼──────┐        │
│  clientApi  │  │  staffApi   │        │
│ (云函数)     │  │ (云函数)     │        │
└──────┬──────┘  └──────┬──────┘        │
       │                │                │
       └───────┬────────┴────────────────┘
               │
         PostgreSQL
         （业务主库）
```

每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

**运行时 100% PostgreSQL，零 MSSQL 依赖。** WorkFine SQL Server 仅供 `db/scripts/sync-workfine.js` 同步模块连接，云函数不直接访问。

## 全局规范

- 小程序前端**仅允许 TypeScript (`.ts`)**，禁止 `.js`；云函数用 `.js`（CloudBase 不支持 TS 直接运行）
- 认证基于微信 OPENID（`cloud.getWXContext()`），客户和员工使用独立用户表
- 云函数响应格式：`{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403
- 错误前缀约定（9 项白名单，三端云函数 + admin 共用单源；详见各端 `utils/error-codes.js` 与 `fengyu-admin/src/lib/api-error.ts`）：
  - `UNAUTHORIZED:` (-401) — 未登录 / openid 失效
  - `PHONE_REQUIRED:` (-403) — 未绑定手机号（**与 `PERMISSION_DENIED` 共享 -403，前端必须按 `errorType` 区分**）
  - `INVALID_PARAMS:` (-400) — 入参不合法
  - `PERMISSION_DENIED:` (-403) — 鉴权失败
  - `NOT_FOUND:` (-404) — 资源不存在 / 不可见
  - `INSUFFICIENT_BALANCE:` (-400) — 储值卡余额 / 剩余次数不足
  - `CONFLICT:` (-409) — 并发冲突 / 唯一约束 / 状态被改
  - `INVALID_STATE:` (-400) — 状态机不允许该操作
  - `CLIENT_NOT_REGISTERED:` (-400) — 顾客未注册 / 未绑定门店（仅 staff/admin 抛）
- 二级前缀语法：允许 `<一级前缀>: <子标签>: <用户消息>` 嵌套（如 `INVALID_STATE: STATE_TRANSITION_BLOCKED: ...`），一级前缀仍走 9 项白名单，子标签 `[A-Z_]+` 仅供日志归类，不计入白名单。
- 跨端一致性由 snapshot 守护：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` + `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 任一漂移立即失败。
- PG 连接池 max 5，懒初始化；云函数用原生 `pg` 库写 SQL，不引入 Drizzle
- 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`，使用 advisory lock 防并发
- 品牌主色 `#C0322A`（中国红）
- **禁止跨端共享代码目录** — 不抽取 `cloudfunctions-shared/` / npm workspace / git submodule / symlink；clientApi、staffApi、payNotify、fengyu-admin 四端共有的工具函数（如 `refund-cascade`、`settlePoints`、`scope`、`error-codes`）一律**各自保留独立副本**，一致性靠 `cross-end-sql-snapshot.test.js` / `cross-end-error-codes-snapshot.test.js` 字面量 snapshot 守护。改一端必同步其它端 + 跑 snapshot 测试。**用户已 veto cloudfunctions-shared 方案**（参考 `notes/memory/feedback_no_shared_cloudfunctions.md`）。

## 常用命令

```bash
docker compose -f docker/docker-compose.yml up -d                   # 本地数据库
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs                       # staff L2 全套（35 个 smoke）
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter order        # 按 module 过滤
bun fengyu-staff/tests/e2e-miniprogram/run-all.mjs                   # staff L3 全套（需 IDE 装 staff 项目）
```

数据库迁移命令见 `db/CLAUDE.md`，云函数部署见 cloudbase-deploy skill，小程序前端使用微信开发者工具打开。

## 规范文档

- `.42cog/cog.md` — 认知模型（核心实体与业务流程）
- `.42cog/real.md` — 现实约束（不可违反的硬规则）
- `.42cog/pm/*.pr.spec.md` — 产品需求规范（backend / client / staff / admin）
- `.42cog/pm/workfine-sync.spec.md` — WorkFine 数据同步规范
- `.42cog/dev/sys.spec.md` — 系统架构规范（各端有独立 sys.spec）
- `.42cog/design/*.ui.spec.md` — UI 设计规范（client / staff / admin）

## 自主工作流

### 编码后自检（每次修改代码后必做）

1. **admin 代码**：修改 `fengyu-admin/src/` 后，立即运行 `cd fengyu-admin && npx tsc --noEmit` 检查类型错误，有错误就在同一轮修复
2. **云函数代码**：修改 `cloudfunctions/*/routes/*.js` 后，检查 SQL 是否用参数化查询（`$1, $2`），OPENID 认证是否正确
3. **小程序页面**：修改 `.wxml` 后，确认 Vant 组件属性和事件名正确（参考 vant-weapp skill 的陷阱列表）

### 结构性变更守卫

修改以下文件时，**先扫描全仓影响再动手**：
- `db/schema/enums.ts` — grep 所有引用该枚举的文件，列出影响范围，确认后再逐层修改
- `db/schema/*.ts` 列定义 — 检查云函数 SQL、admin actions、前端类型定义
- 联合类型/TypeScript 类型定义 — grep 所有 import 该类型的文件

扫描结果展示给用户确认后，按 L0→L10 顺序逐层修改（参考 wx-change-propagation skill 的 10 层传播图）。

### 云函数部署后

每次 /cloudbase-deploy 完成后：
- 提醒验证环境变量（**禁止使用 `tcb fn deploy --force`**，用 `tcb fn code update`）
- 必检变量：clientApi(PG_CONNECTION_STRING, TMAP_KEY, TMAP_SECRET)、staffApi(PG_CONNECTION_STRING, CLIENT_SECRET)

### 跨端变更

涉及 3 个以上目录（db + admin + client/staff）的变更，先用 plan mode 输出计划，用户确认后执行。

### 并行开发（Git Worktree）

并行任务使用 worktree 隔离（项目已配置 `.tree/` 在 .gitignore）：

```bash
scripts/worktree-setup.sh feat/xxx    # 创建 + 复制 .env
cd .tree/feat/xxx && claude             # 独立 Claude 会话
git worktree remove .tree/feat/xxx      # 完成后清理
```

所有 worktree 共享同一个 PG，同一时间只能有一个 worktree 执行 db:migrate。

### 远程部署

管理后台使用本地构建 Docker 镜像 + 远程部署（远程服务器不 build）：

```bash
.claude/skills/remote-deploy/deploy-admin.sh [ali-demo]    # 本地 docker build → 传输 → compose up
```
