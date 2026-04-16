# Ticket: admin 卡包管理页

> 生成日期：2026-04-16
> 严重级别：P2（产品增量；与 `p1-sale-items-store-binding` ticket 的"不在范围内"项对齐补齐）
> 依赖：`p1-sale-items-store-binding` 已 merge（本页依赖 `sale_items.store_id` 做门店隔离）
> 修复归属：单 PR 一次交付
>
> **PR-C**：`src/actions/cards.ts` + `src/app/(main)/cards/*` + 菜单条目 + 权限矩阵更新 + 单测

---

## 0 一句话背景

admin 后台目前没有独立的"卡包管理"视图。运营/客服/店长想查"某顾客在某店有哪些卡、还剩几次、什么时候过期"，只能进顾客详情逐单翻或到 workfine 老系统查。本 ticket 新增 `/cards` 路由，把顾客的**疗程卡**和**单次卡（一次性卡）**聚到一张表格，支持市场/门店二级联合筛选 + 顾客姓名/手机号模糊检索 + 状态筛选 + 分页。

---

## 1 问题定位

### 1.1 admin 现状

当前 `fengyu-admin/src/app/(main)/` 下的 22 个路由里没有卡包管理。最接近的是：

| 现有页面 | 为什么不够用 |
|---|---|
| `customers/` | 只看顾客档案，进详情才能看到订单/卡；跨顾客维度查不了 |
| `orders/` | 按订单维度；一张订单多张卡时得展开每个 item |
| `pickup-records/` | 只看院装产品提货流水；不覆盖疗程卡/单次卡 |
| 员工端 staffApi `customer.paidOrders` | 是员工用的小程序 action，admin 侧无对应视图 |

### 1.2 数据维度确认（已查 5434 数据样本）

执行 `SELECT si.product_type, pc.product_kind, COUNT(*), MIN/MAX(session_count) ...` 的结果：

| product_type | product_kind | rows | min_sc | max_sc |
|---|---|---|---|---|
| 疗程卡 | (null) | 198 004 | 1 | 1 000 000 |
| 单品 | (null) | 9 980 | 1 | 1 |
| 疗程卡 | 护理项目 | 14 | 1 | 12 |
| 单品 | 护理项目 | 5 | 1 | 1 |
| 单品 | 家居产品 | 1 | - | - |

观察：
- **"疗程卡" product_type** 覆盖了 session_count 从 1 到 1 000 000 的一切（其中 session_count=1 的就是"单次卡"）
- **"单品" product_type** 不归"卡包"范畴（它是一次性零售/耗材，不跟踪剩余次数）
- **`product_kind='体验卡'`** 在现行数据里零行（枚举定义有，实际未启用）

**结论**：在本 ticket 范围内，"卡包"= `sale_items WHERE product_type='疗程卡' AND item_direction='购买' AND remaining_sessions IS NOT NULL`。其中 `session_count = 1` 的行在 UI 上以"单次卡"徽章标识；`session_count >= 2` 的为"疗程卡"。

> 若产品方坚持"单次卡 = product_kind='体验卡'" 的别种语义，见 §2.2 备选方案；本 ticket 默认采用 session_count 维度。

### 1.3 schema 依赖

| 位置 | 说明 |
|---|---|
| `db/schema/order.ts:108-158` | sale_items 表（本 ticket 读取；PR-A 已加 store_id NOT NULL） |
| `db/schema/order.ts:148` | 新增的 `idx_sale_items_store_order` 可覆盖 "market/store 筛选 + 分页" 主查询 |
| `db/schema/enums.ts:5` | `productTypeEnum: ["疗程卡", "单品", "院装产品"]` |
| `db/schema/enums.ts:3` | `productKindEnum: ["护理项目", "家居产品", "充值卡", "体验卡"]` |
| `db/schema/user.ts` clientWechatUsers | 顾客姓名 + 手机号（ILIKE 搜索目标） |
| `db/schema/org.ts` stores + orgNodes | 市场/门店联动数据源 |

### 1.4 admin 端已有可复用模板

| 文件 | 可复用点 |
|---|---|
| `fengyu-admin/src/app/(main)/customers/page.tsx:1-39` | Server Component + searchParams 驱动 + Promise.all 并发加载 3 份数据 |
| `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:65-108` | URL-backed filters（`useUrlFilters`）+ 市场→门店 useMemo 级联 + 搜索防抖（300ms） |
| `fengyu-admin/src/actions/customers.ts:130-224` | `CustomerFilters` + `PaginatedCustomers` + 服务端 `WHERE` + `COUNT + LIMIT/OFFSET` 双查并发 |
| `fengyu-admin/src/actions/customers.ts:169-174` | 市场→门店 subquery 模板（`inArray(...boundStoreId, subquery)`），本 ticket 可直接照搬 |
| `fengyu-admin/src/actions/pickup-records.ts:1-35` | 从 sale_items 出发 JOIN stores + clientWechatUsers + productSkus 的范式 |
| `fengyu-admin/src/lib/permissions.ts:15-73` | 权限矩阵（6 角色） |
| `fengyu-admin/src/lib/menu.ts:60-72` | 菜单组"数据管理"，新 item 插入位置 |

---

## 2 设计决策

### 2.1 页面定位

- **路径**：`/(main)/cards`（复数，与 `customers`、`orders`、`services` 风格一致）
- **标题**：卡包管理
- **菜单归属**：`MENU_CONFIG` 第 3 组 "数据管理"，`customers` 之后 / `coupons` 之前
- **图标**：`lucide-react` `CreditCard`（或 `IdCard`，语义上 CreditCard 更贴）
- **权限组**：`sale_item:list`（新增权限 action，避免和 `sale_order:list` 混淆——后者是整单，前者是明细/卡维度）

### 2.2 "单次卡"语义

**默认方案 A（推荐）**：session_count 维度

- 疗程卡：`product_type='疗程卡' AND session_count >= 2`
- 单次卡：`product_type='疗程卡' AND session_count = 1`
- UI 上用徽章区分（`疗程卡` 灰色 tag / `单次卡` 橙色 tag），筛选器含 "全部 / 疗程卡 / 单次卡" 3 选

**备选方案 B**：product_kind 维度

- 单次卡 = `product_kind='体验卡'`（当前数据无，需配合运营侧给 products 表补 category_id）
- 优点：语义更"业务化"（体验卡 = 新客第一张卡）
- 缺点：历史 198 004 行全部拿不到分类，需要大规模数据整理

**备选方案 C**：二者 OR（兼容过渡）

- 单次卡 = `(product_type='疗程卡' AND session_count=1) OR product_kind='体验卡'`
- 风险：去重和 UI 展示规则复杂

> **本 ticket 按方案 A 实施**；若产品方对 B/C 有偏好，迁到 PR 前在本文件补决策记录。

### 2.3 筛选维度

| 维度 | 类型 | URL key | 后端 where |
|---|---|---|---|
| 市场 | 单选下拉 | `market` | `sale_items.store_id IN (SELECT store_id FROM stores INNER JOIN org_nodes ON stores.org_node_id = org_nodes.id WHERE org_nodes.parent_id = $market)` |
| 门店 | 单选下拉（联动） | `store` | `sale_items.store_id = $store` |
| 卡类型 | Segmented（全部/疗程卡/单次卡） | `type` | `全部`: `session_count >= 1`<br>`疗程卡`: `session_count >= 2`<br>`单次卡`: `session_count = 1` |
| 状态 | 单选下拉 | `status` | `有效`: `remaining_sessions > 0 AND (expire_date IS NULL OR expire_date >= CURRENT_DATE)`<br>`已耗尽`: `remaining_sessions = 0`<br>`已过期`: `expire_date < CURRENT_DATE` |
| 顾客搜索 | 文本框（300ms 防抖） | `q` | `ILIKE` 顾客 `name` OR `phone` |

### 2.4 列表字段（表格列）

| 列 | 来源 | 备注 |
|---|---|---|
| 顾客姓名 | `clientWechatUsers.name` | 点击跳 `/customers/[id]` |
| 手机号 | `clientWechatUsers.phone` | 脱敏 `138****5678` |
| 商品 | `sale_items.product_name` (快照) | |
| 规格 | `sale_items.sku_spec_name` (快照) | |
| 类型徽章 | 计算：session_count 1→单次卡 / ≥2→疗程卡 | `Badge` 组件 |
| 剩余 / 总次数 | `remaining_sessions / session_count` | 绿/橙/红色 progress bar |
| 购买门店 | `sale_items.store_id` → JOIN stores/org_nodes | 显示 `市场 · 门店` |
| 购买时间 | `sale_orders.paid_at` | `YYYY-MM-DD` |
| 有效期 | `sale_items.expire_date` | 无则显示"永久" |
| 状态 | 计算值（见 §2.3） | 徽章 |

### 2.5 排序

- 默认：购买时间倒序（`sale_orders.paid_at DESC`）
- 可选：表头点击按"剩余次数 / 有效期"排序（P3，本 ticket 先只支持默认排序）

### 2.6 分页

- 页大小选项：`[10, 20, 50]`，默认 20
- 服务端分页（WHERE + COUNT + LIMIT/OFFSET 双查并发），完全复用 `customers` 页范式

### 2.7 权限模型

新权限 action `sale_item:list` 分配：

| 角色 | 授予 |
|---|---|
| `admin` | ✗（admin 不碰业务数据，与 `sale_order:list` 一致） |
| `manager` | ✓ |
| `finance` | ✓（只读，用于财务核查） |
| `hr` | ✗ |
| `product` | ✗ |
| `customer_mgr` | ✓（与 `customer:list` 配对，方便客服追踪顾客卡） |

scope 过滤：`scopeCondition(session, saleItems.storeId)` —— manager/finance/customer_mgr 按本店/本市场过滤，admin 全量（但 admin 无权限，不会进来）。

### 2.8 不做聚合

每张卡（每个 `sale_item`）独立一行，**不**按 (user, sku) 聚合。理由：
- 同顾客同 SKU 多次购买是常见业务（疗程卡续购），聚合后会丢失购买时间、有效期、余次等关键信息
- 和员工端 `customer.paidOrders` 的行粒度一致，跨端口径统一
- 聚合视图若未来需要，可作为 Phase 2 独立按钮"按顾客+SKU 视图"

---

## 3 实施计划

### 3.1 Server Action（`src/actions/cards.ts` 新建）

| # | 任务 |
|---|------|
| A1 | 定义 `CardFilters`：`{ marketId?, storeId?, type?: 'all'\|'疗程卡'\|'单次卡', status?: 'active'\|'exhausted'\|'expired', search?, page?, pageSize? }` |
| A2 | 定义 `AdminCard` 行模型：含 saleItemId / saleOrderId / productName / skuSpecName / sessionCount / remainingSessions / expireDate / paidAt / storeId / storeName / marketName / clientUserId / clientName / clientPhone |
| A3 | `getCardsPaginated(filters)`：SELECT sale_items JOIN sale_orders JOIN clientWechatUsers JOIN stores + 标量子查询 marketName（参考 customers.ts:14-23） |
| A4 | where 条件：`product_type='疗程卡' AND item_direction='购买' AND remaining_sessions IS NOT NULL` + §2.3 筛选条件 + `scopeCondition(session, saleItems.storeId)` |
| A5 | 并发 `COUNT(*)` + 主查询 LIMIT/OFFSET，返回 `{ data, total }` |
| A6 | 单测 `src/actions/cards.test.ts`：至少 7 条（空筛选、单次卡过滤、疗程卡过滤、市场过滤、门店过滤、搜索 ILIKE、状态过滤 × 3） |

### 3.2 页面（`src/app/(main)/cards/` 新建）

| # | 任务 |
|---|------|
| B1 | `page.tsx`（Server Component）：Promise.all `[getCardsPaginated(...), getStores(), getOrgNodes()]`，透传 searchParams |
| B2 | `_components/cards-page.tsx`（Client Component）：复用 customers-page 的 useUrlFilters + setFilter + 市场→门店 useMemo 级联 + 搜索防抖 300ms |
| B3 | `<Badge>` 展示类型 / 状态 / 进度条；`PhoneMask` 工具函数脱敏 |
| B4 | `loading.tsx`：表格骨架屏（复用 customers/loading.tsx 模式） |

### 3.3 权限 + 菜单

| # | 任务 |
|---|------|
| C1 | `src/lib/permissions.ts:15-73` 为 `manager` / `finance` / `customer_mgr` 添加 `sale_item:list`；admin/hr/product 不动 |
| C2 | `src/lib/menu.ts:60-72` "数据管理"组插入 `{ label: '卡包管理', icon: CreditCard, href: '/cards', requiredRoles: ['manager', 'customer_mgr'], readonlyRoles: ['finance'] }`，位置在"顾客管理"之后 |
| C3 | `src/lib/permissions.test.ts` / `menu.test.ts` 补对应断言 |

### 3.4 可选增强（超纲，P3）

- [ ] 导出 Excel（按当前筛选结果）
- [ ] 批量操作：选中多张卡 → 打印"卡包清单"（交给顾客）
- [ ] 排序表头
- [ ] 按顾客+SKU 聚合视图切换

---

## 4 验收标准

1. **路由**：登录 manager 账号访问 `/cards`，页面正常渲染表格 + 5 个筛选器 + 分页器
2. **权限**：登录 admin 账号访问 `/cards` → 403 或不显示菜单；登录 hr/product 账号同理
3. **scope 隔离**：登录某 manager（scope=某门店），列表只显示该门店售出的卡（即 `sale_items.store_id = 本店`）
4. **市场→门店联动**：选"市场 A"后门店下拉只列 A 下的门店；清空市场则门店全量
5. **类型徽章**：`session_count=1` 显示"单次卡"徽章，`session_count>=2` 显示"疗程卡"徽章
6. **状态判定**：
   - `remaining_sessions > 0 AND (expire_date IS NULL OR expire_date >= today)` → "有效"
   - `remaining_sessions = 0` → "已耗尽"
   - `expire_date < today` → "已过期"
7. **搜索**：输入手机号前 4 位 → 300ms 后触发过滤，只显示匹配的顾客；同样测试姓名
8. **分页**：total > pageSize 时分页器可见；切换 pageSize 从 20→50 时 URL 更新且 page 回到 1
9. **手机号脱敏**：表格显示 `138****5678`，不暴露完整号码
10. **单测**：新增 7 条 action 单测全绿；`bun run test` 整体不引入 regression；覆盖率不跌破 80%

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 198 004 行 sale_items 的 COUNT(*) 慢 | 主查询加强 `(store_id, sale_order_id)` 索引已在 PR-A 建；`item_direction='购买' AND product_type='疗程卡'` 过滤后数据量骤降；若仍慢可加 partial index `CREATE INDEX ... ON sale_items (store_id, remaining_sessions) WHERE product_type = '疗程卡' AND item_direction = '购买'`（本 ticket 不做，观察后评估） |
| 新 `sale_item:list` 权限未覆盖到 E2E test fixtures | 本 ticket 须同步更新 `e2e/fixtures` 里的 seed permission；跑 `bun run test:e2e` 确认新路由不破坏登录跳转 |
| "单次卡"语义未与产品方确认（方案 A vs B vs C） | 默认 A；PR 创建时在描述里标注"语义按方案 A 实施，若需切换请在本文件补决策记录" |
| customers-page 模板用的是 `ilike(name, pattern) OR ilike(phone, pattern)`，pattern 是 `%X%` 格式 | 直接复用，不改变搜索行为 |
| 表格 10 列在窄屏下换行丑 | 列配置标注 `hiddenOnMobile`（参考现有表格组件）；手机号、有效期列在 <md 断点隐藏 |

---

## 6 前置依赖

- ✅ `p1-sale-items-store-binding` ticket 已 merge（需要 `sale_items.store_id` 提供 scope 隔离依据）
- Next.js 15 App Router + Drizzle ORM 2025-12 版本
- 两库 schema 已迁移到 0002_parched_marvel_boy

---

## 7 相关文档

- `fengyu-admin/CLAUDE.md` — admin 总览
- `fengyu-admin/src/app/(main)/customers/page.tsx` + `_components/customers-page.tsx` — 模板页
- `fengyu-admin/src/actions/customers.ts:130-224` — `getCustomersPaginated` 模板
- `fengyu-admin/src/actions/pickup-records.ts` — 从 sale_items 出发的 JOIN 范式
- `fengyu-admin/src/lib/permissions.ts` — 权限矩阵
- `fengyu-admin/src/lib/menu.ts` — 菜单配置
- `notes/tickets/p1-sale-items-store-binding.md` — 前置 ticket（已完成）
- `.42cog/pm/admin.pr.spec.md` — 待该 PR 上线后同步补 AC-19（卡包管理）
