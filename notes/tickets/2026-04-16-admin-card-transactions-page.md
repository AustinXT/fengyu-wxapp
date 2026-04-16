# Ticket: admin 充值卡流水管理页

> 生成日期：2026-04-16
> 严重级别：P2（产品增量；与 `2026-04-16-client-prepaid-card-recharge` 配套，让运营/财务可在 admin 侧查询充值流水）
> 端：fengyu-admin
> 修复归属：单 PR 一次交付（`src/actions/card-transactions.ts` + `src/app/(main)/card-transactions/*` + 菜单条目 + 权限矩阵更新 + 单测）

---

## 0 一句话背景

admin 后台现已有「积分流水」（`/points`）和「疗程卡管理」（`/cards`），但**没有充值卡流水的总览视图**。客户端 PR `2026-04-16-client-prepaid-card-recharge` 上线后，顾客会通过小程序首页发起预付卡充值，门店和员工口头引导的线下充值也都汇入同一张 `card_transactions` 表 —— 财务/店长/客服需要一个分页表格能：按市场/门店看流水、模糊搜顾客、按充值/扣款类型筛、按日期范围导查、并在最上方看到当前筛选下的「总充值 / 总扣款 / 净额 / 笔数 / 涉及顾客数」5 个统计卡片。本 ticket 新增 `/card-transactions` 路由完成这一闭环。

---

## 1 问题定位

### 1.1 admin 现状

`fengyu-admin/src/app/(main)/` 下相关页面：

| 现有页面 | 为什么不够用 |
|---|---|
| `/points` | 积分维度，只覆盖 `point_transactions`，看不到充值卡流水 |
| `/cards` | 疗程卡管理（`sale_items` 维度的卡余次/到期），与"金额预存"是两个语义完全不同的资产 |
| `/customers/[id]` | 顾客详情可能含其名下卡列表（待补），但**跨顾客维度**没有流水查询入口 |
| `/orders` | 订单维度；充值订单虽然按 `2026-04-16-client-prepaid-card-recharge` 走 `sale_orders`，但订单页只能看支付环节，看不到入账后的卡余额变动 |

**缺口**：现有所有页面都不具备"以 `card_transactions` 为粒度的多维度查询"能力。

### 1.2 数据维度

| 表 | 列 | 用途 |
|---|---|---|
| `card_transactions` | `id, card_id, type, amount, ref_order_id, created_at` | 主查询源，每行一条流水 |
| `prepaid_cards` | `card_id, user_id, store_id, balance, created_at, updated_at` | JOIN 拿用户 + 归属门店 |
| `client_wechat_users` | `user_id, name, phone, member_level` | JOIN 拿顾客姓名/手机号（搜索 + 显示） |
| `stores` + `org_nodes` | `store_id → org_node_id → parent_id (市场)` | JOIN 拿门店名 + 市场名（市场→门店级联筛选源） |
| `sale_orders` | `sale_order_id` | LEFT JOIN 拿"关联订单号"（充值流水会有 `ref_order_id`，扣款流水也可能有） |

`cardTransactionTypeEnum`（`db/schema/enums.ts:48`）固定为 `['充值', '扣款']`，类型筛选用静态下拉即可，不需要 `selectDistinct` 动态拉。

### 1.3 schema 约束确认

- `prepaid_cards.store_id` 是 **NOT NULL**（`db/schema/prepaid-card.ts:22-24`），与 `client_wechat_users.boundStoreId` 不同 —— 卡天然按门店切分，scope 过滤直接用 `scopeCondition(session, prepaidCards.storeId)` 即可（比 points 更干净，无 NULL 兜底）
- 客户端 ticket §2.5 提到的「通用卡 store_id=NULL」与现行 schema 矛盾。本 ticket **不处理** schema 改造问题；仍按 NOT NULL 实施，若客户端 PR 真的需要 NULL 卡，由它自己负责 schema 变更
- `idx_prepaid_cards_store_id` 已存在，scope 隔离查询有索引覆盖

### 1.4 admin 端可复用模板

| 文件 | 复用点 |
|---|---|
| `src/actions/points.ts` | 几乎完全对标 —— 市场→门店级联 + 顾客模糊搜索 + 类型筛 + 日期区间 + summary + 服务端分页四查并发；本 ticket 的 action 是它的"姊妹版" |
| `src/app/(main)/points/_components/points-page.tsx` | StatCard 组件 + 5 卡布局 + 筛选器排版 + DataTable + Pagination 的完整骨架可直接照搬，仅替换列定义和统计指标 |
| `src/lib/permissions.ts:15-76` | 复用 `point_transaction:list` 模式：admin / manager / finance 拥有，hr / product / customer_mgr 不拥有；新增 `card_transaction:list` |
| `src/lib/menu.ts:78-110` | 在「数据管理」分组的「积分流水」之后插入新菜单 item |
| `src/lib/utils.ts` | `formatPhone`（脱敏）、`formatDateTime`、金额格式化 |
| `src/components/ui/{badge,data-table,pagination,card,select,input}` | 全部沿用 |

---

## 2 设计决策

### 2.1 页面定位

| 维度 | 选择 |
|---|---|
| 路由 | `/(main)/card-transactions`（避免与已存在的 `/cards` 疗程卡管理冲突，且语义精确表达"流水"） |
| 标题 | 充值卡流水 |
| 菜单归属 | `MENU_CONFIG` 第 3 组「数据管理」，**`积分流水` 之后**（与积分流水风格对齐，便于运营对照查） |
| 图标 | `lucide-react` `Wallet`（区别于已被 `/cards` 占用的 `CreditCard`，且语义为"钱包/余额"，更贴合预付卡） |
| 权限 action | 新增 `card_transaction:list` |

### 2.2 筛选维度

| 维度 | 类型 | URL key | 后端 where |
|---|---|---|---|
| 市场 | 单选下拉 | `market` | `prepaid_cards.store_id IN (SELECT store_id FROM stores INNER JOIN org_nodes ON stores.org_node_id = org_nodes.id WHERE org_nodes.parent_id = $market)` |
| 门店 | 单选下拉（联动） | `store` | `prepaid_cards.store_id = $store` |
| 类型 | 单选下拉（静态） | `type` | `card_transactions.type = $type`（值域 `充值` / `扣款`） |
| 顾客搜索 | 文本框（300ms 防抖） | `q` | `ILIKE` 顾客 `name` OR `phone`，pattern 转义 `%` 和 `_` |
| 起始日期 | `<Input type="date">` | `start` | `card_transactions.created_at >= $start` |
| 结束日期 | `<Input type="date">` | `end` | `card_transactions.created_at <= $end + 'T23:59:59'` |

scope 过滤：`scopeCondition(session, prepaidCards.storeId)` —— admin 全量；其他角色按 `scopeStoreIds` 限定。

### 2.3 顶部统计卡片（参考积分流水 5 卡）

5 个 `<StatCard>`（grid 5 列响应式），统计**当前筛选条件下的全量**（不只是当前页）：

| 指标 | 计算 | 颜色 |
|---|---|---|
| 总充值金额 | `SUM(amount) WHERE amount > 0`（即 `type='充值'` 的金额，按设计 amount 为正） | 成功绿 `#3D8A5A` |
| 总扣款金额 | `SUM(-amount) WHERE amount < 0`（即 `type='扣款'`，按设计 amount 为负，取绝对值显示） | 错误红 `#D94040` |
| 净变动 | `SUM(amount)` | 正绿负红 |
| 流水笔数 | `COUNT(*)` | 默认色 |
| 涉及顾客数 | `COUNT(DISTINCT prepaid_cards.user_id)` | 默认色 |

> **金额符号约定**：`prepaid-card.ts:48-49` 注释为「topup 为正，deduct 为负」，与积分流水的 `+/-` 约定一致。本页据此实现 summary。若线上脏数据有 type='扣款' 但 amount > 0 的情况，summary 仍按符号判断，不按 type 判断，避免双重信号源不一致。

### 2.4 列表字段（表格列）

| 列 | 来源 | 说明 |
|---|---|---|
| 时间 | `card_transactions.created_at` | `formatDateTime`，`whitespace-nowrap` |
| 顾客 | `clientWechatUsers.name + phone` | 双行：姓名 + 脱敏手机号；点击姓名跳 `/customers/[id]` |
| 会员等级 | `clientWechatUsers.memberLevel` | Badge（复用 points 的 `MEMBER_LEVEL_COLORS`） |
| 归属门店 | `stores.store_name + 市场名` | 双行：门店 + 市场（标量子查询拿） |
| 类型 | `card_transactions.type` | Badge：充值蓝 `#5E8BB3` / 扣款橙 `#D4820A` |
| 金额 | `card_transactions.amount` | 等宽字体；`+` 绿 / `-` 红，`formatAmount` 加前缀符 |
| 当前余额 | `prepaid_cards.balance`（拼接显示） | 一行流水后该卡的当前余额；显示 `¥X,XXX.XX` |
| 关联订单 | `card_transactions.ref_order_id` | 等宽 `text-xs`，无关联显示 `—`；点击可跳 `/orders/[id]`（若该 sale_order 存在） |

> **不显示** `card_id` 本身（对运营无意义，PK 形如 `FY-CARD-WX-...`），但保留在 row data 里以备调试。

### 2.5 排序与分页

- 排序：默认 `created_at DESC`，本 ticket **不**做表头点击排序（P3）
- 页大小：`[10, 20, 50, 100]`，默认 20，与 points 一致
- 分页：服务端，并发 `COUNT + 主查询 + summary` 三查（**无** `selectDistinct`，因 type 是静态枚举）

### 2.6 权限模型

新权限 action `card_transaction:list` 分配：

| 角色 | 授予 | 理由 |
|---|---|---|
| `admin` | ✓ | 与 `point_transaction:list` 对齐 —— 充值流水属于"交易性数据"，admin 在系统配置/统计场景需要 |
| `manager` | ✓ | 店长需查本店顾客的充值/扣款 |
| `finance` | ✓（只读） | 财务核对充值收入与扣款（核销）的关键页 |
| `hr` | ✗ | 与 HR 职能无关 |
| `product` | ✗ | 与商品管理无关 |
| `customer_mgr` | ✗ | 客服管顾客档案，不直接看充值流水（如有需要可后续讨论是否加入；保守起见本期不加） |

scope 过滤：`scopeCondition(session, prepaidCards.storeId)` —— admin 全量；manager/finance 按本店/本市场。

> **与 points 权限对照**：points 给了 `admin`/`manager`/`finance`；本页保持一致。客户端 ticket 是否给 `customer_mgr` 看，PR 前可与产品方再对一次。

### 2.7 不做聚合 / 不做汇总切换

- 每条 `card_transactions` 独立一行，不按 (顾客, 卡, 月) 聚合 —— 与 points 范式一致
- 财务月度汇总走 `data-center` 经营数据，不在本页堆叠

### 2.8 与已存在 `/cards` 的区分（避免歧义）

| 路由 | 数据源 | 业务语义 |
|---|---|---|
| `/cards`（已存在） | `sale_items WHERE product_type='疗程卡'` | 疗程卡 / 单次卡 — 余次资产 |
| `/card-transactions`（本 ticket） | `card_transactions JOIN prepaid_cards` | 充值卡 — 金额资产 + 流水 |

二者**不合并、不互链** —— 业务上是两个独立资产域。菜单上一个叫「疗程卡管理」，一个叫「充值卡流水」，文案上做明确区分。

---

## 3 实施计划

### 3.1 Server Action（`src/actions/card-transactions.ts` 新建）

| # | 任务 |
|---|------|
| A1 | 定义 `CardTransactionFilters`：`{ marketId?, storeId?, type?: '充值'\|'扣款', search?, startDate?, endDate?, page?, pageSize? }` |
| A2 | 定义 `AdminCardTransaction` 行模型 + `CardTransactionSummary`（`totalRecharge`, `totalDeduct`, `netChange`, `txnCount`, `userCount`） |
| A3 | `getCardTransactionsPaginated(filters)`：照搬 `points.ts` 的 `buildConditions` 模式，差异点：JOIN `prepaid_cards` → `client_wechat_users` + `stores`/`org_nodes` |
| A4 | scope：`scopeCondition(session, prepaidCards.storeId)` |
| A5 | 三查并发（`COUNT` + 主查询 LIMIT/OFFSET + `summary`）；类型枚举静态，**不**做 `selectDistinct` |
| A6 | 单测 `src/actions/card-transactions.test.ts`：至少 8 条（空筛选、类型=充值、类型=扣款、市场过滤、门店过滤、搜索 ILIKE、日期区间过滤、scope 隔离） |

### 3.2 类型定义（`src/lib/types.ts`）

| # | 任务 |
|---|------|
| T1 | 新增 `AdminCardTransaction`：`{ id, cardId, userId, type, amount, balance, refOrderId, createdAt, customerName, customerPhone, memberLevel, storeId, storeName, marketName }` |
| T2 | 新增 `CardTransactionSummary`：`{ totalRecharge, totalDeduct, netChange, txnCount, userCount }` |

### 3.3 页面（`src/app/(main)/card-transactions/` 新建）

| # | 任务 |
|---|------|
| B1 | `page.tsx`（Server Component）：`Promise.all([getCardTransactionsPaginated(filters), getStores(), getOrgNodes()])`，透传 searchParams |
| B2 | `_components/card-transactions-page.tsx`（Client Component）：复制 `points-page.tsx` 骨架，按 §2.3/§2.4 调整 StatCard 文案 + 列定义 + 类型下拉为静态 2 项 |
| B3 | `loading.tsx`：表格骨架屏（复用 points/loading.tsx 模式） |

### 3.4 权限 + 菜单

| # | 任务 |
|---|------|
| C1 | `src/lib/permissions.ts`：为 `admin` / `manager` / `finance` 添加 `'card_transaction:list'`；其他角色不动 |
| C2 | `src/lib/menu.ts`：在「数据管理」分组「积分流水」之后插入：<br>`{ label: '充值卡流水', icon: Wallet, href: '/card-transactions', requiredRoles: ['admin', 'manager'], readonlyRoles: ['finance'] }` |
| C3 | `src/lib/permissions.test.ts` / `menu.test.ts` 补对应断言（admin/manager/finance 可见；hr/product/customer_mgr 不可见） |

### 3.5 可选增强（超纲，P3）

- [ ] 导出 Excel（按当前筛选）
- [ ] 表头排序（按金额/时间）
- [ ] 跳转「关联订单」详情页（先确认 sale_order 存在再 link）
- [ ] 顾客详情页 `/customers/[id]` 内嵌"该顾客充值卡 + 流水"折叠面板（独立 ticket）

---

## 4 验收标准

1. **路由**：登录 admin/manager/finance 账号访问 `/card-transactions`，页面正常渲染 5 张统计卡 + 5 个筛选器 + 表格 + 分页器
2. **权限**：登录 hr/product/customer_mgr 账号 → 菜单不可见；强行访问 URL → 抛 `PERMISSION_DENIED`
3. **scope 隔离**：登录某 manager（scope=某门店），列表只显示 `prepaid_cards.store_id = 本店` 的流水
4. **市场→门店联动**：选「市场 A」后门店下拉只列 A 下门店；清空市场则门店全量
5. **类型筛选**：下拉仅 3 项「全部类型 / 充值 / 扣款」（**不**动态拉）
6. **日期区间**：选 `start=2026-04-01, end=2026-04-15` → 只返回该区间流水（含 4-15 当天 23:59:59）
7. **搜索**：输入手机号前 4 位 → 300ms 后触发过滤，只显示匹配顾客的流水；姓名同理；特殊字符 `%`/`_` 被正确转义
8. **统计卡**：5 卡数值与 DB 实际 SUM/COUNT 一致；切换筛选后所有卡片同步更新
9. **金额符号**：`+1000` 绿色 / `-200` 红色；净变动正绿负红
10. **会员等级 Badge** 显示与 points 页颜色一致（`黑钻/金钻/粉钻/星钻/初钻`）
11. **手机号脱敏**：`138****5678`，不暴露完整号码
12. **分页**：total > pageSize 时分页器可见；切换 pageSize 从 20→50 时 URL 更新且 page 回到 1
13. **关联订单为空**显示 `—`
14. **单测**：新增 8 条 action 单测全绿；`bun run test` 整体不引入 regression；覆盖率不跌破 80%
15. **类型检查**：`cd fengyu-admin && npx tsc --noEmit` 通过
16. **菜单单测**：`menu.test.ts` 断言 admin/manager/finance 可见 `充值卡流水`，hr/product/customer_mgr 不可见

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 与已存在的 `/cards`（疗程卡管理）造成菜单歧义，运营搞混 | 菜单文案明确区分「疗程卡管理」（余次资产）vs「充值卡流水」（金额资产）；页面 H1 标题同样区分 |
| 客户端 PR `2026-04-16-client-prepaid-card-recharge` 未上线时，`card_transactions` 数据稀疏（仅 WorkFine 历史数据） | 不阻塞本 ticket，页面可独立上线；空状态由 `<DataTable>` 默认提示处理 |
| `prepaid_cards.store_id` schema 是 NOT NULL，但客户端 ticket §2.5 计划"通用卡 store_id=NULL" | 本 ticket 按现行 schema 实施；若客户端真改 schema，本页 scope 过滤需补 NULL 兜底（届时同 PR 改） |
| `card_transactions` 量级未来大（每顾客每次消费扣款 1 行），COUNT 慢 | 现有 `idx_card_txns_card_id` 仅按 card_id；scope 过滤主路径走 `prepaid_cards.store_id` (有索引)；若慢可加 `(created_at DESC)` 索引（本 ticket 不做，观察后评估） |
| 类型枚举若未来扩值（如新增 `退款`/`赠送`），下拉硬编码会漏 | 在 `_components/card-transactions-page.tsx` 顶部用常量 `const TYPE_OPTIONS = ['充值', '扣款']`，并附注释「与 `db/schema/enums.ts:cardTransactionTypeEnum` 同步」；schema 改时全仓 grep 替换 |
| `point_transactions` 和 `card_transactions` 列名相似（都有 `type`/`amount`/`ref_order_id`），后端 SUM CASE WHEN 写错列易出错 | 严格 import `cardTransactions` 表对象，所有 SQL 通过 Drizzle column 引用，避免裸 SQL 字符串 |
| `card_transactions.ref_order_id` 类型是 `varchar(30)`，跳订单详情时需校验存在 | P3 增强项，本 ticket 仅显示 ID 不做跳转，避免 404 |

---

## 6 前置依赖

- Next.js 15 App Router + Drizzle ORM 当前版本
- `prepaid_cards` / `card_transactions` 表已存在（`db/schema/prepaid-card.ts`），两库（5433 + 5434）schema 一致
- 客户端充值 PR（`2026-04-16-client-prepaid-card-recharge`）**非阻塞** —— 本页能独立上线，先承接 WorkFine 历史流水，客户端 PR 上线后自动开始展示新数据

---

## 7 相关文件

- `fengyu-admin/CLAUDE.md` — admin 总览
- `fengyu-admin/src/actions/points.ts` — **核心模板**（直接照搬整体结构）
- `fengyu-admin/src/app/(main)/points/_components/points-page.tsx` — UI 模板
- `fengyu-admin/src/lib/permissions.ts:15-76` — 权限矩阵
- `fengyu-admin/src/lib/menu.ts:78-110` — 数据管理分组
- `db/schema/prepaid-card.ts` — 主数据源 schema
- `db/schema/enums.ts:48` — `cardTransactionTypeEnum`（充值 / 扣款）
- `notes/tickets/2026-04-16-admin-card-management.md` — 邻接 ticket（疗程卡管理，避免与本页混淆）
- `notes/tickets/2026-04-16-client-prepaid-card-recharge.md` — 配套客户端 ticket（充值入口与支付闭环）
- `.42cog/pm/admin.pr.spec.md` — 待该 PR 上线后同步补 AC（充值卡流水）

---

## 8 待产品确认（PR 前可澄清）

1. `customer_mgr` 角色是否需查充值流水？默认**不给**，与 points 对齐（points 也未给 customer_mgr）
2. "当前余额"列是否必要？该列每行都需要 JOIN `prepaid_cards.balance`，若不需可移除（轻微减负）
3. 时间筛选默认值：是否需"默认本月"（提升财务核对效率）？目前所有现有页面均**不**默认；本 ticket 保持一致
4. 关联订单是否需要可点跳转？P3 增强，本期仅展示 ID
