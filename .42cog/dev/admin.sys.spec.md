# 凤御管理后台（fengyu-admin）— 系统架构规格书

> 仅记录代码中无法推断的架构决策和约束机制。目录结构、API 列表、DB schema 请直接读取代码。

## 1. 架构拓扑

```text
┌── 浏览器 ───────────────────────────────────┐
│  fengyu-admin（Next.js 15 SSR/RSC）          │
│  JWT Token 认证（手机号+密码）                │
└──────┬──────────────────────────────────────┘
       │ HTTPS（REST API Routes）
       ▼
┌─ adminApi（Next.js API Routes）─────────────┐
│  独立 PG 连接池 · Better Auth · Drizzle ORM  │
│  PERMISSION_MATRIX + buildScopeWhere         │
└──────┬──────────────────────────────────────┘
       │
       ▼
  PostgreSQL（自托管，与小程序端共享同一实例）

┌── 小程序端（独立，无代码依赖）──────────────┐
│  clientApi / staffApi（CloudBase 云函数）     │
│  各自独立 PG 连接池 · 原生 SQL                │
└─────────────────────────────────────────────┘
```

**关键隔离**：
- adminApi 与 staffApi/clientApi **零代码依赖**——各自独立实现 DB 连接、权限校验、业务逻辑
- 三端共享同一 PG 实例为唯一耦合点，业务规则以 `backend.pr.spec.md` 为唯一真相源
- 小程序端用原生 SQL（CloudBase 不支持 TS），adminApi 用 Drizzle ORM（Next.js 环境原生支持）

## 2. 架构决策

| 决策 | 理由 |
|------|------|
| Next.js 15 全栈（非 CloudBase 云函数） | 管理后台需要 SSR/RSC 性能、Server Actions、文件路由等 Web 能力；CloudBase 云函数无 HTTP 路由层 |
| adminApi 用 Drizzle ORM（非原生 SQL） | 与 db/ 目录共享 schema 定义，类型安全；Next.js 环境无 CloudBase 包体积和冷启动限制 |
| Better Auth 认证（非微信 openid） | Web 端无微信小程序运行时，走手机号+密码→JWT；admin_passwords 表存 bcrypt 哈希 |
| shadcn/ui + Tailwind（非自研组件） | 管理后台以表格/表单为主，shadcn/ui 提供完整的 Data Table、Form、Dialog 等组件 |
| 独立 PG 连接池 | adminApi 请求量和模式与小程序端不同，连接池参数需独立调优，避免互相影响 |
| 业务逻辑独立实现（不复用 staffApi 代码） | CloudBase 云函数是 JS + 原生 SQL，adminApi 是 TS + Drizzle，语言和 ORM 不同无法复用；规则一致性由 backend.pr.spec.md 保障 |
| bun 包管理 | 安装速度快、原生支持 TS、与 Next.js 15 兼容 |

## 3. 集成边界

| 外部系统 | 角色 | 访问方式 | 说明 |
|---------|------|---------|------|
| PostgreSQL | 运行时依赖 | Drizzle ORM（adminApi Server Actions / API Routes） | 与小程序端共享同一实例，独立连接池 |
| WorkFine SQL Server | 同步触发 | adminApi 调用 `db/scripts/sync-workfine.js` | admin 手动触发全量/增量同步，非运行时依赖 |
| CloudBase 云存储 | 运行时依赖 | CloudBase SDK（图片上传） | 商品封面图、门店环境图等静态资源 |
| staffApi / clientApi | 无直接依赖 | — | 三端通过共享 PG 实现数据一致，无 API 调用 |

**不依赖**：微信支付（Web 端无 JSAPI 能力）、微信身份认证（走手机号+密码）

## 4. 约束保障机制

| real.md 约束 | adminApi 技术实现 |
|-------------|------------------|
| 次数防超卖 | Drizzle 原子 UPDATE：`set({ remainingSessions: sql\`remaining_sessions - ${n}\` }).where(gte(remainingSessions, n))`，rowCount=0 即次数不足 |
| 价格快照不可变 | sale_items 创建时写入 unit_price，Drizzle schema 无 UPDATE 暴露；管理后台修改商品价格不回溯已有订单 |
| 支付幂等 | `update().where(and(eq(id, $1), eq(status, '待支付')))`，rowCount=0 即跳过；服务完成按 service_order_id 幂等 |
| 状态单向推进 | 所有状态变更 WHERE status = 当前状态，Drizzle 条件构建保障；admin 角色也不可绕过状态机 |
| 后端统一鉴权 | Next.js middleware 校验 JWT → 查 permission_roles → 构造 ctx.auth；PERMISSION_MATRIX 代码常量（含 admin 列）|
| 组织域数据隔离 | `buildScopeWhere(auth)`：admin → 空条件（等同 headquarters）；其他角色 → `store_id IN (scopeStoreIds)` |
| 待支付订单唯一 | PG 部分唯一索引 + 应用层 pre-check（与 staffApi 共享同一 DB 约束） |

**adminApi 特有保障**：
- 乐观锁：所有数据管理 UPDATE 携带 `WHERE updated_at = $prev`，rowCount=0 返回"数据已被修改"
- 登录安全：bcrypt (cost ≥ 12) + 连续 5 次失败锁定 15 分钟 + must_change 首次登录强制改密
- 敏感操作审计：admin 角色变更、权限分配/撤销强制写入 operation_logs

## 5. 跨模块业务流

### 管理后台开单 → 顾客支付（跨 Web + 小程序）

```text
adminApi:order.create → PG 写入订单(待支付)
  → adminApi:order.qrcode → 生成可打印二维码图片(含小程序码 order_no)
  → 顾客扫码 → clientApi:order.pay → 微信支付
  → payNotify(CloudBase) → 更新订单(已支付) + 写入 paid_at + 自动业绩分配
```

> adminApi 开单后无法直接触发微信支付（无 JSAPI），必须通过小程序端完成支付闭环。

### 数据同步（admin 手动触发）

```text
adminApi:sync.trigger → 互斥锁检查
  → 调用 db/scripts/sync-workfine.js（WorkFine MSSQL → PG UPSERT）
  → 同步 org_nodes / stores / staff_wechat_users / client_wechat_users / commission_rate_matrix
  → 写入同步日志（新增/更新/跳过行数）
  → 不覆盖 created_by != 'sync' 的手动权限记录
```

## 6. 权限模型

### 角色×模块矩阵（adminApi 扩展，含 admin 列）

| 模块 | admin | manager | finance | hr | product | customer_mgr |
|------|-------|---------|---------|-----|---------|-------------|
| org CRUD | ✅ 全局 | - | - | ✅ scope | - | - |
| store CRUD | ✅ 全局 | - | - | ✅ scope | - | - |
| employee CRUD | ✅ 全局 | - | - | ✅ scope | - | - |
| product CRUD | ✅ 全局 | - | - | - | ✅ | - |
| commission CRUD | ✅ 全局 | - | - | - | - | - |
| customer R/W | - | ✅ scope | R scope | - | - | ✅ scope |
| coupon CRUD | ✅ 全局 | - | - | - | ✅ | - |
| sale_order 操作 | - | ✅ scope | R scope | - | - | - |
| allocation 操作 | - | ✅ scope | R scope | - | - | - |
| service 全部 | - | ✅ scope | - | - | - | - |
| appointment 全部 | - | ✅ scope | - | - | - | - |
| permission 管理 | ✅ 全局 | - | - | ✅ scope | - | - |
| sync 触发 | ✅ | - | - | - | - | - |
| operation_log | ✅ | - | - | - | - | - |
| data_center | - | ✅ scope | ✅ scope | - | - | - |

### 数据隔离规则

- **admin**：`buildScopeWhere()` 返回空条件，等同 headquarters，无数据过滤
- **非 admin 角色**：`store_id IN (scopeStoreIds)`，scopeStoreIds 由 permission_roles 的 scope_id 通过 org_nodes 树递归展开
- **一人多域**：取所有域的 store_id 并集
- **staff 不可登录管理后台**；customer_mgr 可登录（仅看到顾客管理菜单）
- **admin 只分配 admin**：只有 admin 角色可分配/撤销 admin；hr 不可操作 admin 角色
- **scope 传递约束**：hr 分配权限时，被分配者的 scope_id 必须在操作者 scope 范围内
