# fengyu-analyst 独立分析站点技术方案

日期：2026-07-21

## 背景

新版 `fengyu-analyst` 需要从当前 Python + Streamlit 原型迁移为 Next.js 应用。它需要具备独立站点和子域名，支持移动端访问，同时又不能成为一套独立账号、独立权限、独立数据库的系统。

最终定位：

- `fengyu-analyst` 是独立部署的分析站点。
- `fengyu-analyst` 复用 `fengyu-wxapp` 的 PostgreSQL 业务主库。
- `fengyu-analyst` 复用 `fengyu-admin` 的登录态、用户、角色、权限矩阵和组织 scope。
- `fengyu-admin` 提供入口，用户点击后以单点登录方式进入分析站点。

## 目标架构

```text
admin.fengyu.xxx
  -> fengyu-admin
  -> 登录、权限矩阵、后台入口

analyst.fengyu.xxx
  -> fengyu-analyst
  -> 看板、智能分析助手、指标知识库

共享能力：
  -> PostgreSQL 业务主库
  -> db/schema Drizzle schema
  -> staff_wechat_users / permission_roles
  -> system_configs.permission_matrix
  -> fy-admin-token JWT Cookie
  -> JWT_SECRET
```

## 技术栈

`fengyu-analyst` 必须与 `fengyu-admin` 对齐：

- Next.js 15.x App Router
- React 19
- TypeScript strict
- Tailwind CSS 4
- Drizzle ORM + `postgres`
- `jose` 校验 JWT
- `recharts` 图表
- `lucide-react` 图标
- `sonner` 轻提示
- Vercel AI SDK 7 作为 Agent/工具调用框架
- Node.js >= 22

不使用：

- 不使用 Python 后端
- 不使用 Streamlit
- 不使用 Prisma
- 不继续使用 `smolagents`
- 不直接读取旧 `UDV_273` 作为新站点运行时数据源

## 代码位置

推荐在 `fengyu-wxapp` monorepo 内新增兄弟应用：

```text
fengyu-wxapp/
  fengyu-admin/
  fengyu-analyst/
  db/
    schema/
```

当前 worktree：

```text
/Users/nv/proj.xt.com/worktrees/fengyu-wxapp/analyst/fengyu-wxapp
```

## 单点登录

登录仍由 `fengyu-admin` 承担。`fengyu-analyst` 不提供用户名密码登录页。

访问流程：

1. 用户访问 `https://analyst.fengyu.xxx`。
2. `fengyu-analyst` middleware 读取 `fy-admin-token`。
3. 使用共享 `JWT_SECRET` 校验 JWT。
4. 根据 JWT payload 中的 `employeeId` 查询 `staff_wechat_users`。
5. 查询 `permission_roles` 和 `org_nodes`，生成 `AuthSession`。
6. 根据权限点判断是否允许进入分析站点。
7. 未登录时跳转到 `fengyu-admin` 登录页，并携带 `returnTo`。

生产 Cookie 必须支持跨子域共享：

```ts
{
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  domain: ".fengyu.xxx",
  path: "/",
  maxAge: 24 * 60 * 60
}
```

本地开发可使用同一 hostname 的不同端口，例如：

```text
http://localhost:3000  -> fengyu-admin
http://localhost:3100  -> fengyu-analyst
```

## 权限策略

长期建议新增分析站点权限点：

```text
analyst:view
analyst:chat
analyst:export
```

落地顺序建议：

1. 第一阶段先用现有 `data_center:dashboard` 作为访问门槛，避免开发初期阻塞。
2. 第二阶段在 `system_configs.permission_matrix` 和权限矩阵 UI 中补齐 `analyst:*`。
3. 第三阶段把 `ANALYST_VIEW_ACTION` 切换为 `analyst:view`。

默认角色建议：

| 角色 | 权限 |
| --- | --- |
| admin | `analyst:view`, `analyst:chat`, `analyst:export` |
| manager | `analyst:view`, `analyst:chat` |
| finance | `analyst:view`, `analyst:export` |

所有查询必须叠加组织 scope：

- admin 或总部 scope：可查看全部。
- 市场 scope：仅查看市场下门店。
- 门店 scope：仅查看本店。

## 数据库口径迁移

旧 `fengyu-analyst` 使用 SQL Server `UDV_273`，新站点运行时必须使用 `fengyu-wxapp` PostgreSQL 主库。

字段映射：

| 旧字段/概念 | 新库来源 |
| --- | --- |
| 顾客编号 | `sale_orders.client_user_id`，必要时关联 `client_wechat_users.customer_id` |
| 销售流水号 | `sale_orders.sale_order_id` / `sale_items.sale_item_id` |
| 实收金额 | `sale_items.received`，单位为元 |
| 日期 | `sale_orders.paid_at` |
| 门店 | `sale_orders.store_id` |
| 市场 | `stores -> org_nodes` |
| 品项分类 | `sale_items.sku_id -> product_skus -> product_categories` |

复购门槛：

- 旧库金额单位为 10 元，旧代码门槛为 198。
- 新库金额单位为元，应复用 `getMemberThreshold()`，默认 1980。

复购率核心口径：

```text
复购率 = 复购人数 / 品项进入总人数

品项进入：
  同一顾客、同一天、同门店、同品项的购买合并后，实收金额达到门槛。

复购：
  进入后，后续非同日达标购买。

排除：
  与首次进入同一天的新开卡项不算复购。
```

## 移动端要求

移动端不是桌面页缩放，必须作为一等场景设计：

- 手机端使用单列布局。
- 筛选器使用抽屉或底部 sheet。
- KPI 卡片支持 2 列或 1 列自适应。
- 图表优先展示核心指标，避免密集多轴。
- 表格在手机端转为卡片列表。
- 智能助手输入区固定底部。
- 会话列表使用抽屉。
- 触控目标不小于 44px。

## 页面模块

```text
/
  -> /dashboard

/dashboard
  -> 复购 KPI
  -> 月度趋势
  -> 市场对比
  -> 门店排名
  -> 导出入口

/assistant
  -> 智能分析助手
  -> 流式回答
  -> 工具调用图表

/knowledge
  -> 指标口径
  -> 复购率规则
  -> 数据源说明
```

## Agent 选择

选择 Vercel AI SDK，不使用 `smolagents`。

原因：

- 与 Next.js Route Handler 直接集成。
- 支持流式输出。
- 支持工具调用。
- 工具可以直接调用 Drizzle 查询函数。
- TypeScript + Zod 参数边界更适合当前全栈 Next.js 方案。

第一批工具：

```text
queryRepurchaseRate
queryRepurchaseTrend
queryCategoryComparison
queryMarketComparison
queryStoreRanking
```

每个工具都必须绑定当前 `AuthSession`，不能让模型自行传入权限范围。

## 开发准备清单

- [ ] `fengyu-analyst` 应用骨架
- [ ] 共享 Drizzle schema 路径 `@db/*`
- [ ] 共享 JWT Cookie 校验
- [ ] 共享 PostgreSQL 连接方式
- [ ] `ANALYST_VIEW_ACTION` 访问闸门
- [ ] admin 登录 Cookie 支持跨子域
- [ ] admin 菜单入口跳转到 analyst 子域名
- [ ] 复购率 SQL/TypeScript 口径迁移
- [ ] Streamlit 旧结果抽样对账
- [ ] 移动端截图验收
