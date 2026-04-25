# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

凤御美业管理后台（Admin Panel），基于 Next.js 15 全栈架构。**DB 集成、认证、权限均已实现。**

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 15 (App Router, RSC, Server Actions) |
| 语言 | TypeScript strict |
| 样式 | Tailwind CSS v4 + 自定义 CSS 变量 |
| 组件 | 自建 shadcn/ui 风格组件（无 Radix UI 依赖） |
| ORM | Drizzle ORM（复用 `../db/schema/`） |
| 认证 | JWT（手机号+密码 → admin_passwords bcrypt → httpOnly cookie） |
| 状态 | Zustand（仅 UI 状态）+ Server Component 数据获取 |
| 测试 | Vitest（单元 537 用例）+ Playwright（E2E 21 spec） |
| 包管理 | bun |

## 目录结构

```
fengyu-admin/
├── src/
│   ├── app/
│   │   ├── (auth)/            # 登录/改密（无 Shell 布局）
│   │   ├── (main)/            # 主布局（Sidebar + TopBar）
│   │   │   ├── dashboard/     # 工作台（角色自适应看板）
│   │   │   ├── orders/        # 订单管理 + 开单向导
│   │   │   ├── allocations/   # 营业额分配（含提成比例自动参考）
│   │   │   ├── services/      # 服务单（状态机+原子扣减）
│   │   │   ├── appointments/  # 预约（URL Tabs + 筛选）
│   │   │   ├── org/           # 组织架构（树形编辑）
│   │   │   ├── stores/        # 门店
│   │   │   ├── employees/     # 员工（含调店 scope 同步）
│   │   │   ├── products/      # 商品 + 分类 + SKU
│   │   │   ├── commission/    # 提成矩阵
│   │   │   ├── customers/     # 顾客
│   │   │   ├── coupons/       # 优惠券
│   │   │   ├── permissions/   # 权限管理
│   │   │   ├── sync/          # 数据同步
│   │   │   ├── logs/          # 操作日志
│   │   │   ├── settings/      # 系统配置
│   │   │   └── data-center/   # 数据中心（P2）
│   │   └── globals.css        # Tailwind + 品牌色 CSS 变量
│   ├── actions/               # Server Actions（19 模块，全部接真实 PG）
│   ├── components/
│   │   ├── ui/                # 基础 UI 组件（Button, DataTable, Pagination, AlertDialog 等）
│   │   └── layout/            # 布局组件（Sidebar, Topbar, Breadcrumb）
│   ├── db/                    # Drizzle 连接初始化
│   └── lib/
│       ├── auth.ts            # JWT 校验 + session 提取
│       ├── permissions.ts     # PERMISSION_MATRIX + scopeCondition + requirePermission
│       ├── operation-log.ts   # 审计日志写入
│       ├── schemas.ts         # Zod 验证 schema
│       ├── types.ts           # TypeScript 类型定义
│       ├── menu.ts            # 角色驱动菜单可见性
│       ├── utils.ts           # cn() + 格式化工具
│       └── hooks/             # useUrlFilters, useUnsavedChanges
├── e2e/                       # Playwright E2E 测试（21 spec）
└── vitest.config.ts
```

## 常用命令

```bash
bun install                    # 安装依赖
bun run dev                    # 开发服务器（Turbopack）
bun run build                  # 生产构建
bun run lint                   # ESLint

# 测试
bun run test                   # Vitest 单元测试（537 用例，29 文件）
bun run test:watch             # Vitest watch 模式
bun run test:coverage          # 覆盖率报告（Stmts 89% / Funcs 84%，含 src/lib + src/actions）
bun run test:e2e               # Playwright E2E（需运行中的 dev server）
bun run test:all               # Vitest + Playwright
```

## 架构要点

- **Server Actions 直连 PG**：19 个 action 模块通过 Drizzle ORM 操作 PostgreSQL，无 mock
- **JWT 认证**：middleware.ts 校验 `fy-admin-token` cookie → 查 `permission_roles` → 构造 `ctx.auth`
- **6 角色权限**：admin/manager/finance/hr/product/customer_mgr，PERMISSION_MATRIX 代码常量
- **scope 数据隔离**：`scopeCondition(session, table.storeId)` — admin 无过滤，其他角色按 `scopeStoreIds` 过滤
- **乐观锁**：所有数据管理 UPDATE 携带 `WHERE updated_at = $prev`，rowCount=0 提示刷新；所有编辑表单均传递 `expectedUpdatedAt`
- **审计日志**：所有增删改通过 `logOperation()` 写入 `operation_logs`（AC-11 全覆盖）
- **服务端分页**：6 个列表页（orders/services/appointments/customers/employees/allocations）使用 DB 级 WHERE + COUNT + LIMIT/OFFSET，通过 `searchParams` 驱动 Server Component 重新查询；Pagination 组件含输入防护（负值/NaN/越界/除零）
- **员工调店 scope 同步**：`updateEmployee` 变更 storeId 时自动同步 `permission_roles.scope_id`
- **列表默认排序**：配置/档案型 `desc(updatedAt), desc(createdAt), desc(id)`（"编辑即浮顶"）；业务时间型 `desc(业务时间)` 优先；流水型 `desc(createdAt)`。例外必须在 `.orderBy(...)` 上方写 `// 例外：...` 注释。详见 `.42cog/dev/admin.sys.spec.md` §5

## cron-worker 子模块

`src/cron/` 是迁自 `fengyu-client/cloudfunctions/cronTask` 的每日 03:00 定时任务，作为独立 Node 进程（`docker-compose` 的 `cron-worker` 服务）与 admin web 同镜像部署。

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `src/cron/index.ts` | node-cron 调度（`0 3 * * *` Asia/Shanghai）+ `--once` 单次模式 |
| 调度 | `src/cron/run.ts` | 串行 5 STEP，每个 STEP 独立 try/catch（单 STEP 失败不阻塞下一个） |
| 配置缓存 | `src/cron/config.ts` | `getMemberThreshold` 双层缓存（30s/5min TTL） |
| STEP 1 | `steps/refresh-customer-status.ts` | 重算 `customer_status`（三段式 SQL，整体一个事务） |
| STEP 2 | `steps/refresh-member-levels.ts` | 重算 `member_level` + 升降级权益（消息/积分/优惠券） |
| STEP 3 | `steps/grant-birthday-benefits.ts` | 当日生日权益（年度幂等键 `bday-{YYYY}`） |
| STEP 4 | `steps/grant-thanksgiving-benefits.ts` | 仅每月 20 号；月度幂等键；优惠券固定 10 天 |
| STEP 5 | `steps/audit-points-balance.ts` | 积分余额校验（仅告警不修复） |

**本地运行**：
```bash
bun run cron:once   # 立即跑一次后退出，本地冒烟
bun run cron:dev    # 长驻调度（开发模式）
```

**生产容器内手动触发**：`docker exec fengyu-cron-worker node cron-worker.js --once`

**约定**：`operation_logs.source` 写 `'cronTask'`（保留语义，便于历史日志追溯）；`benefits` 类配置（含 `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits`）每次跑前重读 `system_configs`，不缓存。

## 测试覆盖率

覆盖率范围含 `src/lib/` + `src/actions/` + `src/cron/`（`data-center.ts` / `cron/index.ts` 除外），阈值 80%：

| 维度 | 当前值 |
|------|--------|
| Statements | 89.53% |
| Branches | 84.99% |
| Functions | 84.73% |
| Lines | 90.50% |

已测 action 模块（18/19）：orders, services, appointments, customers, employees, stores, products, commission, coupons, org, permissions, allocations, store-unbind, auth, dashboard, logs, sync, settings。

## 状态色

待处理 `#D4820A` / 成功 `#3D8A5A` / 进行中 `#5E8BB3` / 完结 `#888888` / 错误 `#D94040`

## 规范文档

- `.42cog/pm/admin.pr.spec.md` — 产品需求（AC-01~AC-18 验收标准）
- `.42cog/dev/admin.sys.spec.md` — 系统架构（约束保障机制）
- `.42cog/design/admin.ui.spec.md` — UI 设计（页面规格 + 组件规范）
