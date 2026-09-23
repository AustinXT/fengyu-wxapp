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
│   │   │   ├── (workspace)/dashboard/             # 工作台
│   │   │   ├── (operations)/                      # 开单、订单、服务、预约、退款等经营业务
│   │   │   ├── (customer-operations)/             # 顾客、卡券、会员权益与流水
│   │   │   ├── (catalog)/                         # 商品与商城
│   │   │   ├── (inventory)/inventory/             # 库存管理（库存、单据、资料、促销）
│   │   │   ├── (organization)/                    # 组织、门店、商户、员工、提成
│   │   │   ├── (analytics)/data-center/[board]/   # 数据中心（销售/客量/人效/品项）
│   │   │   └── (system)/                          # 权限、消息、日志、系统配置
│   │   └── globals.css        # Tailwind + 品牌色 CSS 变量
│   ├── actions/               # Server Actions（18 模块，全部接真实 PG）
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
│       ├── menu.ts            # 权限驱动的业务域二级菜单
│       ├── utils.ts           # cn() + 格式化工具
│       └── hooks/             # useUrlFilters, useUnsavedChanges
├── tests/                     # 唯一测试入口（详见 tests/README.md）
│   ├── setup.ts               # Vitest setup
│   ├── e2e-actions/           # bun + 直调 Server Action smoke（如 recordPayment）
│   ├── e2e-pages/             # Playwright 自动套件（21 spec + visual/，CI 跑）
│   └── e2e-chains/            # Playwright 跨页跨角色业务链路（link-1~23 + 独立 config）
└── vitest.config.ts
```

路由组仅用于源码组织，公开 URL 保持不变（如订单仍是 `/orders`）。侧边栏采用手风琴二级菜单：工作台直达；经营业务、客户运营、商品商城、库存管理、组织管理、数据中心、系统管理按叶子权限过滤。数据中心的四个板块各占一条路径（`/data-center/{sales|customer|efficiency|product}`），裸 `/data-center` 只做跳转（兼容旧 `?tab=` 深链）。库存管理的“资料配置”由 `/inventory/skus`、`/inventory/suppliers`、`/inventory/sku-mappings` 三个保留深链的页签构成。

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

# admin Server Action smoke（bun-driven，直接 import admin actions + 真 PG）
bun fengyu-admin/tests/e2e-actions/smoke-record-payment.mjs   # recordPayment 全链路
bun fengyu-admin/tests/e2e-actions/cleanup.mjs                # 清理 TE2L2_ 命名空间残留

# admin Chrome 跨页业务链路（Playwright headed/headless 都行）
bun run test:e2e:manual                                       # 全套 23 link
bunx playwright test --config=tests/e2e-chains/playwright.manual.config.ts tests/e2e-chains/link-1-*.spec.ts
```

## 架构要点

- **Server Actions 直连 PG**：19 个 action 模块通过 Drizzle ORM 操作 PostgreSQL，无 mock
- **原生 SQL 的 bigint 返回 string**：`db.execute(sql\`\`)` / `tx.execute(sql\`\`)` 不经 drizzle 列映射，schema 里的 `bigserial({mode:'number'})` 对它无效；postgres.js 对 `int8`(OID 20) 与 `bigint[]`(OID 1016) 无 parser，原样返回 `string` / `string[]`。**禁止**把这类列与 number 直接 `===` 比较、做算术、或当 `Map`/`Set` 的 key 与 number key 混用，一律显式 `Number()`；行类型也别裸标 `id: number`（TS 断言撒谎不会报警）。走 drizzle query builder（`db.select()`）时才是真 number。同理，单测 mock 这类 RETURNING 行必须用字符串 id，否则 mock 漂移会掩盖真实缺陷
- **JWT 认证**：middleware.ts 校验 `fy-admin-token` cookie → 查 `permission_roles` → 构造 `ctx.auth`
- **6 角色权限**：admin/manager/finance/hr/product/customer_mgr，PERMISSION_MATRIX 代码常量
- **统一鉴权 HOF**：`src/actions/**/*.ts` 的每个 export 必经 `withPermission(action, fn)` / `withAnyPermission(actions[], fn)`（`@/lib/with-permission`），ESLint `no-restricted-syntax` AST 规则强制（`auth.ts` 公共入口除外）。详见下方"Server Actions 写法范式"
- **scope 数据隔离**：`scopeCondition(session, table.storeId)` — admin 无过滤，其他角色按 `scopeStoreIds` 过滤
- **乐观锁**：所有数据管理 UPDATE 携带 `WHERE updated_at = $prev`，rowCount=0 提示刷新；所有编辑表单均传递 `expectedUpdatedAt`
- **审计日志**：所有增删改通过 `logOperation()` 写入 `operation_logs`（AC-11 全覆盖）
- **服务端分页**：6 个列表页（orders/services/appointments/customers/employees/allocations）使用 DB 级 WHERE + COUNT + LIMIT/OFFSET，通过 `searchParams` 驱动 Server Component 重新查询；Pagination 组件含输入防护（负值/NaN/越界/除零）
- **员工调店不动角色绑定**（#249，2026-09-22 拍板）：`updateEmployee` 变更 storeId 时**不再**自动搬迁 `permission_roles.scope_id` —— 数据模型没有「该绑定随主门店移动」的语义标记，自动搬迁等于猜；且搬迁实质是「旧店 revoke + 新店 grant」而该 action 只闸 `employee:update`。旧店残留绑定随成功响应回传（分三种：scope 内查到则附角色清单；旧店超 scope 则**不查不披露角色名**、只给降级提示；确实无绑定则普通文案），提示**中性**——「旧店仍有绑定」≠「新店缺授权」（允许多绑定下 B 店可能本来就有，照补会撞唯一约束），由持 `permission:assign` 的人判断是保留兼任还是改绑。另：**复职**必须提示权限状态（与调不调店无关），且基于**实查** `permission_roles` ——「离职 ⇒ 角色已清空」会破（历史的独立提交时序**已由事务化修掉**但存量残留仍在；`sync-workfine.js` 改 `is_resigned` 不碰角色这条**至今有效**），实查为空提示「需重新授权」、非空提示「仍保留…即恢复生效」。标记离职的员工行 UPDATE + 删角色 + revoke 审计在**同一事务**内（`logOperation` 传 `tx`）。离职员工能登录这个口子已在 #318 关掉（见下条）
- **三个不变量守卫的收口**（#318）：锁的定义与**取锁顺序**统一在 `src/lib/invariant-locks.ts`（① `org_nodes:reparent` → ② `admin:active_count` → ③ 行锁，反序即 `40P01` 死锁且无人翻译 → 用户看到 500）。三处落地：(1) `updateOrgNode` 改挂父节点时在锁内复核子树员工的门店/组织归属自洽（#259 的另一侧，不自洽则回滚并列出姓名，内部哨兵 `ORG_OWNERSHIP_CONFLICT` 已登记进跨端 `TX_SENTINELS` 白名单）；(2) `permissions.ts` 的 `revokeRole` 撤超管时与 employees 侧共用 `admin:active_count` 那把锁，取锁+计数+DELETE+审计同一事务（撤非超管不取锁）；(3) `auth.ts` 的 `login` **与** `getSessionFromCookie` 都过滤 `is_resigned = false` —— 只挡 login 不够，JWT 24h 内旧会话仍有效；登录失败文案与密码错误**逐字相同**，否则「已离职」可探测。⚠️ `{storeId: null, orgNodeId: 指向某门店}` 这个「半填」组合**刻意放行**（#259 选项 A，甲方 2026-09-23 拍板），两侧口径都必须放过，别再当缺口修
- **列表默认排序**：配置/档案型 `desc(updatedAt), desc(createdAt), desc(id)`（"编辑即浮顶"）；业务时间型 `desc(业务时间)` 优先；流水型 `desc(createdAt)`。例外必须在 `.orderBy(...)` 上方写 `// 例外：...` 注释。详见 `.42cog/dev/admin.sys.spec.md` §5

## Server Actions 写法范式

每个 Server Action 必须用 HOF 包装，HOF 内部承担 `getSession + requirePermission` 入口拦截。业务函数收到非空 `AuthSession` 作为第一参数；`scopeCondition` / `isInScope` / `hasPermission` / `logOperation` 在体内继续按需调用。

**单一权限**（`withPermission`）：

```ts
'use server'
import { withPermission } from '@/lib/with-permission'

export const createPosition = withPermission(
  'employee:update',
  async (session, data: { name: string }) => {
    await db.insert(positions).values({ ...data })
    await logOperation(session, 'position.create', 'position', data.id, data)
    return { success: true }
  },
)
```

**OR 关系**（`withAnyPermission`，业务+审批双角色入口）：

```ts
export const getRefundDetail = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, refundId: string) => { /* ... */ },
)
```

**禁用裸 `export async function`**（`auth.ts` 公共入口 `login` / `logout` / `getSessionFromCookie` / `checkMustChange` 例外）；权限不足 throw `PERMISSION_DENIED: <action>`，session 缺失 redirect `/login?expired=1`。

## cron-worker 子模块

`src/cron/` 是迁自 `fengyu-client/cloudfunctions/cronTask` 的每日 03:00 定时任务，作为独立 Node 进程（`docker-compose` 的 `cron-worker` 服务）与 admin web 同镜像部署。

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `src/cron/index.ts` | node-cron 调度（`0 3 * * *` Asia/Shanghai）+ `--once` 单次模式 |
| 备份 | `src/cron/database-backup.ts` | 03:00 定时备份、手动队列、磁盘复检、完整性校验与 7/30 天清理 |
| 调度 | `src/cron/run.ts` | 串行 13 STEP，每个 STEP 独立 try/catch（单 STEP 失败不阻塞下一个） |
| 配置缓存 | `src/cron/config.ts` | `getMemberThreshold` 双层缓存（30s/5min TTL） |
| STEP 1 | `steps/close-expired-appointments.ts` | 关闭超期未到店预约 |
| STEP 2 | `steps/refresh-customer-status.ts` | 重算 `customer_status`（三段式 SQL，整体一个事务） |
| STEP 3 | `steps/refresh-monthly-activity.ts` | 重算 `monthly_activity` 月度客活（按当月到店天数；2026-05-26 从 db/scripts 纳入） |
| STEP 4 | `steps/refresh-member-levels.ts` | 重算 `member_level` + 升降级权益（消息/积分/优惠券） |
| STEP 5 | `steps/refresh-spending-tier.ts` | 重算 `spending_tier` 终身消费档位（2026-05-26 从 db/scripts 纳入） |
| STEP 6 | `steps/grant-birthday-benefits.ts` | 当日生日权益（年度幂等键 `bday-{YYYY}`） |
| STEP 7 | `steps/grant-thanksgiving-benefits.ts` | 仅每月 20 号；月度幂等键；优惠券固定 10 天 |
| STEP 8 | `steps/reset-cross-store-flags.ts` | 仅重置顾客临时跨店标记（写入清扫；员工出差已改为长期保留，2026-07-13） |
| STEP 9 | `steps/audit-points-balance.ts` | 积分余额校验（仅告警不修复） |
| STEP 10 | `steps/audit-role-type-nulls.ts` | sa/sc role_type NULL 监控（只读告警） |
| STEP 11 | `steps/audit-payment-invariants.ts` | 6 项资金不变量守护（只读告警） |
| STEP 12 | `steps/audit-refund-cascade-coverage.ts` | 退款 5 通道级联巡检（只读告警） |
| STEP 13 | `steps/audit-store-unbind-orphans.ts` | 门店解绑孤儿巡检（只读告警） |

**本地运行**：
```bash
bun run cron:once   # 立即跑一次后退出，本地冒烟
bun run cron:dev    # 长驻调度（开发模式）
```

**生产容器内手动触发**：

```bash
docker exec fengyu-cron-worker node --conditions=react-server cron-worker.mjs --once
```

⚠️ 入口是 `cron-worker.mjs`（`docker/Dockerfile.admin` 把 bundle 产物 COPY 到容器根），写 `.js` 会
`MODULE_NOT_FOUND`；`--conditions=react-server` 也不能省（bundle 内含 RSC 条件导出），与
`docker/docker-compose.yml` 的 `command` 保持一致。加 `--only=<stepName>` 可只跑单个 STEP。
判成功看输出末尾的 `one-shot done: {"ok":true,...}`——中间刷的大量 audit 告警是只读巡检，不代表失败。
⚠️ `one-shot done` **只有 `--once` 分支才打**（`src/cron/index.ts:48`），别拿它判断 03:00 那一跳。

⚠️ **手动触发必须与 03:00 定时跑错开**。`src/cron/index.ts` 的调度是
`runBackupTick().then(() => runDailyJobs())`，**先备份、备份完才跑 STEP**，所以 STEP 的真实执行窗口
在备份之后（时长视库大小，不是固定的 03:00–03:03）。定时跑**没有专门的结束日志**，判它跑完要看
最后一个 STEP 的行日志出现：`[cron-worker] storeUnbindOrphans: {...}`（`src/cron/run.ts` STEPS 末项）。
`runDailyJobs` 没有任何互斥（无进程锁 / 无 advisory lock），撞上去可能 40P01 死锁，
输的那一跑整个 STEP 回滚。

**约定**：`operation_logs.source` 写 `'cronTask'`（保留语义，便于历史日志追溯）；`benefits` 类配置（含 `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits`）每次跑前重读 `system_configs`，不缓存。

## 系统自检

`/settings/diagnostics` 仅 `system:diagnostics` 可访问，包含子系统/拉卡拉双 Tab。cron/export worker 通过 `SYSTEM_RUNTIME_DIR` 上报心跳；Admin 与 cron 通过 `DATABASE_BACKUP_REQUEST_DIR` 交换备份请求和脱敏状态，真实 dump 仅存在 cron 可见的 `DATABASE_BACKUP_DIR`。不得把 dump 目录挂载到 admin web，也不得增加浏览器下载/删除/恢复入口。

## 测试覆盖率

覆盖率范围含 `src/lib/` + `src/actions/` + `src/cron/`（`cron/index.ts` 除外），阈值 80%：

| 维度 | 当前值 |
|------|--------|
| Statements | 89.53% |
| Branches | 84.99% |
| Functions | 84.73% |
| Lines | 90.50% |

已测 action 模块（18/18）：orders, services, appointments, customers, employees, stores, products, commission, coupons, org, permissions, allocations, store-unbind, auth, dashboard, logs, sync, settings。

## 状态色

待处理 `#D4820A` / 成功 `#3D8A5A` / 进行中 `#5E8BB3` / 完结 `#888888` / 错误 `#D94040`

## 规范文档

- `.42cog/pm/admin.pr.spec.md` — 产品需求（AC-01~AC-18 验收标准）
- `.42cog/dev/admin.sys.spec.md` — 系统架构（约束保障机制）
- `.42cog/design/admin.ui.spec.md` — UI 设计（页面规格 + 组件规范）
