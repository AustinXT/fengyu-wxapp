# Ticket: 开单要求顾客已登录小程序并绑定门店（admin + 员工端）

> 生成日期：2026-04-24
> 严重级别：P1（业务规则收紧，影响 admin + 员工端两条开单主链路）
> 归属页面：
>   - `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx`
>   - `fengyu-staff/miniprogram/pages/order-create/order-create.ts`
> 关联后端：
>   - `fengyu-admin/src/actions/orders.ts#createOrder` + `createConversionOrder`
>   - `fengyu-staff/cloudfunctions/staffApi/routes/order.js#createOrder / createConversion / createRepayment / createRefund`
> 拆分方式：单 feature 分支，2 个 PR 串行 merge（A 后端守卫 → B 双端前端）；或并行 merge 由 reviewer 评估
> 无 DB schema 变更 / 无 migration

---

## 0 一句话背景

当前 admin 与员工端开单页都允许"搜索不到顾客时，输入一个 11 位手机号直接开单"。这条路径会在 `sale_orders.client_user_id` 写入 `NULL`、`client_phone` 写入手动输入的号码；业务侧反馈该通道造成三类问题：

1. 顾客始终"游离"在微信身份之外——订单不会进入该顾客的小程序"我的订单"，积分/储值卡/会员等级都挂不上
2. 后续手机号重复录错、拼写/区号错误的手机号进库，清理成本极高
3. 统计口径下的"注册率"被虚高账号污染；转换单、充值卡、储值卡入账等能力全部依赖 `client_user_id`，`manualPhone` 路径开出的单事实上拿不到这些能力，制造了"业务断层"

业务诉求：**开单前必须先在小程序端完成登录 + 绑定门店**，admin/员工端只能为"客户端小程序里已注册并绑定门店"的顾客开单。搜索不到顾客的唯一处置是：引导顾客用自己手机打开小程序走登录流程。

---

## 1 现状 vs 目标

### 1.1 Admin 开单页（`orders/_components/order-create-page.tsx`）

| 行为 | 现状 | 目标 |
|---|---|---|
| 搜索结果为空 | 黄色警告卡 + 输入框 `manualPhone`，提示"可输入手机号直接开单，顾客后续注册绑定手机号后历史订单会自动关联"（`:548-560`） | 灰色提示卡"该手机号尚未注册凤御小程序或未绑定门店，请引导顾客在客户端小程序完成登录并绑定门店后再开单"；**不显示输入框**；无下一步按钮可用 |
| Step 0 → Step 1 按钮 | `disabled = !selectedCustomer && !(searchDone && 手机号正则通过)`（`:576`） | `disabled = !selectedCustomer` — 纯粹依赖"从搜索结果里选中一位" |
| 提交 `createOrder` payload | `clientUserId: selectedCustomer?.userId ‖ null`；`clientPhone/customerName` 回退到 `manualPhone`（`:1057-1059`） | `clientUserId: selectedCustomer.userId`（非空）；`clientPhone/customerName` 从 `selectedCustomer` 原值取 |
| `manualPhone` state | `useState("")`（`:120`）+ 6 处引用 | **移除** state 与所有引用 |

### 1.2 员工端开单页（`miniprogram/pages/order-create/order-create.ts`）

| 行为 | 现状 | 目标 |
|---|---|---|
| 搜索输入 `customerPhone` | 输入完整 11 位手机号 → 调 `customer.search`（`:653-675`） | 保持 |
| 搜索结果为空 | `setData({ customerInfo: { id: '', name: '', phone } })` + toast "未注册顾客，将以手机号开单"（`:665-668`） | **不再** 写入空 id 的 fake `customerInfo`；toast 改为"该手机号未注册小程序或未绑定门店，无法开单；请引导顾客本人在小程序登录后再来"；`customerInfo` 保持为 `null` |
| Step 0 → Next 条件 | `if (!this.data.customerInfo)`（`:683`） | 隐含收紧：`customerInfo` 在未命中时仍为 null，既有校验即可拦截；但需再加一道 `if (!customerInfo.id) {... '请先选择已注册顾客' ...}` 防御（避免未来任何意外路径把空 id 塞进来） |
| `onSelectRecentCustomer` | 从最近顾客缓存点选（`:677-680`）| 保持，但只有已注册（`id` 非空）的项才进缓存 |
| 提交 `order.create` payload | `clientUserId: customerInfo.id ‖ null`（`:915, :994`） | `clientUserId: customerInfo.id`（非空） |

### 1.3 后端网关

| 接口 | 现状 | 目标 |
|---|---|---|
| `fengyu-admin … createOrder` | `clientUserId: string | null` 允许为 null；仅在"充值卡订单"分支显式拒 null（`:512-567`） | 入口统一 `if (!data.clientUserId) return { success:false, message:'CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店' }`；类型签名收窄为 `clientUserId: string` |
| `fengyu-admin … createConversionOrder` | 已经强制 `clientUserId` 非空（`:905-906` 注释 + `:938` 校验） | 无需改动，仅文案与 admin 主 createOrder 对齐错误前缀 |
| `fengyu-staff … createOrder`（`routes/order.js:162`+） | 查 `client_wechat_users WHERE phone = $1`，查不到则 `clientUserId=null` 继续开单（`:223-247`） | 查不到 → `throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')`；移除下方"未命中顾客时按 phone+storeId 查同手机号待支付订单"这段 fallback（`:239-247` 整块）。同时把 `createRepayment / createRefund / createConversion` 入口都加这一条前置守卫 |

### 1.4 是否也要求"已绑定门店"（`bound_store_id IS NOT NULL`）

**推荐方案**：是。业务语义上"绑定门店"是客户与门店的履约关系基础，没绑定门店的顾客意味着他只是注册了账号但没选定服务门店——开单会造成一笔"门店归属错位"的风险。

落地在 admin `searchCustomers` 与员工端 `customer.search` 两处，加 `AND bound_store_id IS NOT NULL` 过滤；前端文案统一提"登录小程序并绑定门店"。

**灰度建议**：考虑到 WorkFine 同步历史顾客（`openid IS NULL`）仍保留在 `client_wechat_users` 里，这部分历史顾客**默认视为已注册**（因为 WorkFine 迁移已完成，历史顾客已按 phone 落地，且多数有 `bound_store_id`）。是否要同时要求 `openid IS NOT NULL`（真正登录过微信端）是一个独立决策点，见 §5。

---

## 2 设计决策

### 2.1 "已登录 + 已绑定"的技术判定

| 口径 | 实现 | 采用 |
|---|---|---|
| A — 只要 `client_wechat_users` 有行 | `searchCustomers` 现状即是 | ❌ 太宽，包含仅 WorkFine 同步但从未接触过小程序的顾客，达不到业务意图 |
| B — `openid IS NOT NULL` | `WHERE openid IS NOT NULL` 过滤 | ❌ **2026-04-24 业务确认：不采用**。有大量从旧系统（WorkFine）接入的老顾客已经存在但从未使用过 client 小程序，`openid` 永远是 NULL；要求 openid 非空会直接把这批存量顾客全部锁在门外 |
| C — `bound_store_id IS NOT NULL` | `WHERE bound_store_id IS NOT NULL` 过滤 | ✅ **采用**：WorkFine 同步时已按 `store_name` 解析并写入 `bound_store_id`；新用户必须走小程序绑定门店才能被搜到；旧接入顾客只要有归属门店也能被搜到 |
| D — C + openid 任一满足 | `WHERE bound_store_id IS NOT NULL OR openid IS NOT NULL` | 🤔 宽松折中，但在语义上含糊，不采 |

**采用 C**。理由：
- `bound_store_id` 是业务履约关系的硬性字段，缺失意味着这个顾客本质上没进入任何门店的服务范围
- 老顾客（WorkFine 同步）绝大多数已有 `bound_store_id`，不会被误杀
- 新顾客必须走 `fengyu-client` 的 `store.bindStore` 才能拿到 `bound_store_id`，与业务文案"登录小程序并绑定门店"语义一一对应
- 搜索 `searchCustomers` 加 `AND bound_store_id IS NOT NULL` 单一条件即可，改动最小
- **显式放弃 `openid IS NOT NULL`**：2026-04-24 业务方确认，旧系统接入的老顾客数据可能长期没有 openid（从未打开过 client 小程序），这部分顾客业务上仍然需要被开单；强行要求 openid 会直接破坏存量业务。因此"登录小程序"在文案上是对新顾客的引导话术，在技术判定上仅以 `bound_store_id` 为准

> `stores.storeId` FK 约束已保障 `bound_store_id` 的合法性，无需额外校验。

### 2.2 错误前缀 `CLIENT_NOT_REGISTERED:`

按 CLAUDE.md 规范 "错误前缀约定：`UNAUTHORIZED:`、`PHONE_REQUIRED:`、`INVALID_PARAMS:`、`PERMISSION_DENIED:`"，本 ticket 新增一个前缀 `CLIENT_NOT_REGISTERED:`。

| 位置 | 使用 |
|---|---|
| admin `createOrder` / `createConversionOrder` | `return { success: false, message: 'CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店' }` |
| staff `order.create/createRefund/createRepayment/createConversion` | `throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')` |

前端映射 UI 文案时去前缀展示"顾客未注册小程序或未绑定门店，请引导顾客在小程序完成登录并绑定门店后再来开单"。

### 2.3 文案（指导用户行动）

统一三处文案：
- admin Step 0 空结果卡：
  > 未找到已注册顾客
  > 本系统仅支持为"已在凤御小程序登录并绑定门店"的顾客开单。
  > 请让顾客在客户端小程序完成登录与门店绑定后，再用姓名/手机号搜索。
- 员工端空结果 toast（或底部 action-sheet）：
  > 该手机号尚未注册小程序或未绑定门店，无法开单
  > 请引导顾客本人使用微信扫码登录凤御小程序并绑定门店
- 后端错误返回：`CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店`

### 2.4 不改动 DB schema

- `client_wechat_users` 现有字段全满足
- `sale_orders.client_user_id` 当前是 `nullable`，本 ticket **不把它改成 NOT NULL**（历史行存在 null，改 NOT NULL 需要数据清洗；请与财务/会计确认后另开 ticket）
- `sale_orders.client_phone` 保留 nullable 不变

### 2.5 充值卡 / 转换单 / 回款单 / 退款单 的影响

| 订单类型 | 现状 | 改后 |
|---|---|---|
| 充值卡 | 已强制 `clientUserId` 非空 | 无需改 |
| 转换单 | admin 已强制；staff `createConversion` 内部校验可能也已有 — 补一条入口统一守卫 | 统一错误前缀 |
| 回款单 | staff `createRepayment` 当前未强制 — **加入守卫** | ✅ |
| 退款单 | 依赖原订单的 `client_user_id`，若原订单为 manualPhone 开的 → `client_user_id IS NULL` 场景存在 — **保持宽松**（退款不能因新规卡历史单） | ⚠️ 参见 §5 风险 |

### 2.6 `manualPhone` 相关测试的废止

`fengyu-admin/src/actions/orders.test.ts:628` 有一条 `it('订单无 clientUserId（manualPhone 开单） → 不触发 prepaid_cards 写入', …)` 原意是验证"不写 prepaid_cards"。本 ticket 后 **创建侧** 不再有该路径，但 `confirmOfflinePayment` 仍需对 DB 中已存在的历史 `client_user_id=null` 订单做防御（不写 prepaid_cards）。改法：保留测试语义，把 case 名重命名为 `历史订单 client_user_id=null（迁移前 manualPhone 遗留） → 充值入账跳过`，断言不变。

---

## 3 实施计划

### PR-A：后端守卫 + searchCustomers 过滤（先行 merge，单测可跑）

| # | 任务 | 文件 / 位置 |
|---|---|---|
| A1 | `createOrder` 入口统一守卫：`if (!data.clientUserId) return { success:false, message:'CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店' }`；类型签名 `clientUserId: string | null` → `clientUserId: string` | `fengyu-admin/src/actions/orders.ts:512-547` 开头 |
| A2 | `searchCustomers` 查询加过滤 `AND bound_store_id IS NOT NULL` | `fengyu-admin/src/actions/customers.ts:88-112` |
| A3 | 员工端 `order.create` 路由：`clientUsers.length === 0` 时 `throw new Error('CLIENT_NOT_REGISTERED: …')`；删除 `:239-247` 的 phone+storeId 查待支付订单 fallback 分支；下方 `clientUserId` 参与的 SQL 全部按非空处理 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:223-247` |
| A4 | 员工端 `createRepayment / createConversion` 入口追加同样前置守卫（`createRefund` 因历史订单问题**跳过**，见 §5.退款风险） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1217` / `:1339` |
| A5 | 员工端 `customer.search` 路由加 `AND bound_store_id IS NOT NULL`（与 admin 对齐） | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js`（搜 `SELECT … FROM client_wechat_users … WHERE phone` 的那处） |
| A6 | 单测（Vitest）新增：admin `createOrder({clientUserId: null, …})` → `success:false` + message 含 `CLIENT_NOT_REGISTERED`；`searchCustomers` → 不返回 `bound_store_id IS NULL` 的行 | `fengyu-admin/src/actions/orders.test.ts` + `customers.test.ts` |
| A7 | 废止现有 `it('订单无 clientUserId（manualPhone 开单） → 不触发 prepaid_cards 写入')`：保留测试，case 名改为 `历史订单 client_user_id=null（迁移前 manualPhone 遗留） → 充值入账跳过`，断言不变 | `orders.test.ts:628` |
| A8 | 操作日志：对 `CLIENT_NOT_REGISTERED` 拒单**不写 `operation_logs`**（失败前置守卫，不视为"操作"）；若需审计风控，本 ticket 不做，后续如果有"开单尝试监控"需求再开 | `src/lib/operation-log.ts` 不改 |

### PR-B：双端前端下线 `manualPhone` / 空 `customerInfo` 路径

| # | 任务 | 文件 |
|---|---|---|
| B1 | admin 删除 state `manualPhone` 及全部引用（`:120, :226, :555, :570, :576, :767, :1058-1059`） | `orders/_components/order-create-page.tsx` |
| B2 | admin 搜索空结果卡改为灰色提示卡（文案见 §2.3），无输入框、无下一步 | 同上 `:547-561` |
| B3 | admin Step 0 → Step 1 `disabled = !selectedCustomer` | 同上 `:565-580` |
| B4 | admin 提交 `createOrder` payload：`clientUserId: selectedCustomer.userId`（非空）；`clientPhone/customerName` 从 `selectedCustomer` 取（移除 manualPhone 兜底） | 同上 `:1050-1085` |
| B5 | admin 搜索结果为空时 toast 去掉 `"可输入手机号直接开单"`，改为"未找到已注册顾客，请引导顾客登录小程序"（`:176`） | 同上 `:161-183` |
| B6 | 员工端 `onSearchCustomer` 空结果分支：不写 fake customerInfo，改为 `wx.showModal({ title:'无法开单', content:'该手机号尚未注册小程序或未绑定门店…', showCancel:false })`；`customerInfo` 保持 `null`（`:665-668`） | `pages/order-create/order-create.ts` |
| B7 | 员工端 `onStep0Next` 追加 `if (!this.data.customerInfo?.id)` 防御（`:682-690`） | 同上 |
| B8 | 员工端 `recentCustomers` 缓存逻辑：只缓存 `id` 非空的项；启动时过滤掉历史 null id（`:198`） | 同上 |
| B9 | 员工端提交 `order.create` / `order.createConversion` payload：`clientUserId: customerInfo.id`（非空）；移除 `|| null` 兜底（`:915, :994`） | 同上 |
| B10 | E2E（Playwright）：admin 搜索不存在手机号 → 看到灰色提示 + Next 按钮 disabled；无法进入 Step 2 | `fengyu-admin/e2e/orders-create-flow.spec.ts` 或新增 `e2e/orders-require-registered.spec.ts` |
| B11 | 员工端小程序手工验证清单：搜索未注册手机号 → 看到 modal → 不可进入 Step 2；搜索已注册未绑店顾客（手动在 DB 制造）→ 同样被拒；搜索已注册已绑店顾客 → 正常下一步 | `notes/meetings/` 或 ticket §4 验收 |

---

## 4 验收标准

1. **admin Step 0 UI**：搜索结果为空时无 `manualPhone` 输入框；出现灰色指引卡片；"下一步"按钮 disabled
2. **admin 数据**：`createOrder` 的 TypeScript 类型签名 `clientUserId: string`（非空）；调用方传 null 会触发编译错误
3. **admin 后端守卫**：直接绕过 UI 构造 `clientUserId: null` 的 POST 请求 → 返回 `success:false, message` 以 `CLIENT_NOT_REGISTERED:` 开头
4. **员工端 UI**：搜索未注册手机号 → 出现 modal 而非 toast；`customerInfo` 保持 null；"下一步"按钮 disabled
5. **员工端 recent 缓存**：app 启动时若 `recentCustomers` 缓存中有 `id=''` 的历史项，自动清理
6. **searchCustomers 过滤**：DB 中手工插入一行 `client_wechat_users(phone='13900000001', openid='x', bound_store_id=NULL)` → admin 搜索该号返回 0 条；`bound_store_id` 设为合法 store → 返回 1 条
7. **员工端 customer.search 一致过滤**：同 6
8. **历史订单兼容**：在 DB 里制造一笔 `sale_orders(client_user_id=NULL)` 历史订单 → admin 订单列表/详情正常打开；`confirmOfflinePayment` 不抛错；不写入 `prepaid_cards`
9. **转换单 + 回款单**：两条路径前置均拒绝 `clientUserId` 为空（即使前端绕过）
10. **类型检查**：`cd fengyu-admin && bun run build` 通过；`bun run test` 全绿（28+ 文件）
11. **E2E**：新增 spec `搜索未注册顾客无法开单` 通过
12. **文案审核**：产品方确认 admin 灰色卡 + 员工端 modal + 后端错误返回三处文案一致且指向"登录小程序并绑定门店"

---

## 5 风险与决策点

| 风险 / 决策 | 处理 |
|---|---|
| 退款单（`createRefund`）原订单可能是历史 manualPhone 开的（`client_user_id=NULL`）| **不加** `CLIENT_NOT_REGISTERED` 前置守卫；退款是对历史订单的反向操作，锁死会阻塞清算。`createRefund` 按原订单的 `client_user_id` 原样带回即可（即使为 null） |
| WorkFine 同步历史顾客可能 `bound_store_id IS NULL` 的比例 | **提前拉一个 count**：`SELECT COUNT(*) FROM client_wechat_users WHERE bound_store_id IS NULL`；若 >5% 的活跃顾客因此被挡住，需先跑一次"按 WorkFine 最近服务门店回填 bound_store_id"的脚本才能上线 PR-A。**PR-A 上线前必须跑这个 count 并由业务方确认** |
| `openid IS NULL` 是否一并要求 | **2026-04-24 决议：永久不要求**。旧系统接入的老顾客数据中存在大量"有档案、有绑定门店、但从未使用过 client 小程序"的记录（openid 恒为 NULL），业务上这些顾客仍须能被开单。无 follow-up ticket |
| 员工端搜索改为 `showModal` 而不是 toast | 原因：拒单是终止性错误，需要用户主动点"知道了"才继续操作；toast 会在几秒后自动消失，易被忽略。但需与产品确认 UX |
| `sale_orders.client_user_id` 是否顺手改 NOT NULL | **不改**。历史 null 行需要先清洗；本 ticket 仅收紧"新开单入口"，不动既有数据。未来清洗完成后另开 ticket 走 migration |
| 并发：顾客刚登录完小程序但 `client_wechat_users` 的 commit 还没对 admin 可见（极短窗口） | 实际不会出现，因为 admin 与 client 都是同一 PG 主库；顾客登录成功后刷新 admin 搜索即可命中 |
| 测试库 `fengyu@5434` 种子数据不符合新规 | 准备 seed 补丁：给所有 `bound_store_id IS NULL` 的种子顾客补 `bound_store_id`，或新增一批用于"未注册"场景的空绑定顾客供测试 |
| 文案里提到"登录小程序"是否被误解为"打开小程序就算"| 文案显式写"登录并绑定门店"；后端双条件守卫（其实仅判 bound_store_id）已事实覆盖"登录"语义（只有登录后才可能有 bound_store_id）|
| 前端在 `searchCustomers` 返回 0 时已经能判定，是否还需要后端再拒一次 | 必须。后端守卫是单一可信点；前端任何绕过（F12 改 DOM / 直接调 action）都会被挡住 |
| 国际化：搜索关键词含中文姓名时 | 现有 `ilike` 对中文无碍；过滤条件 `bound_store_id IS NOT NULL` 与关键词无关 |

---

## 6 前置依赖与环境

- 无 schema 变更，无 migration，无双库同步
- admin 测试库 5434/fengyu 需做一次种子核对：确保样本顾客至少一半有 `bound_store_id`，一半无（用于新规场景测试）
- 员工端无需部署客户端小程序；`fengyu-client` 的登录流程保持不变，本 ticket 不动
- CloudBase：PR-A 员工端云函数 `staffApi` 改动后需走 `/cloudbase-deploy`；环境变量无变化

---

## 7 相关引用

- `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` — `:120 manualPhone state`、`:176 toast`、`:547-561 空结果卡`、`:576 disabled 条件`、`:1058-1059 提交 payload`
- `fengyu-admin/src/actions/orders.ts` — `:512 createOrder 入口`、`:565 充值卡独有守卫`、`:905 createConversionOrder`
- `fengyu-admin/src/actions/customers.ts` — `:88 searchCustomers`
- `fengyu-staff/miniprogram/pages/order-create/order-create.ts` — `:195 customerPhone state`、`:653-675 onSearchCustomer`、`:682 onStep0Next`、`:915/:994 提交 payload`
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` — `:162 createOrder`、`:223-247 顾客查询+null 分支`、`:1217 createRepayment`、`:1339 createConversion`
- `db/schema/user.ts` — `clientWechatUsers.openid / boundStoreId` 列定义
- CLAUDE.md — 错误前缀约定
- MEMORY v3.1 — client_wechat_users 合并后字段清单

---

## 8 不在本 ticket 范围

- [ ] `sale_orders.client_user_id` 改 NOT NULL（需清洗历史数据）
- [ ] 退款单强制"原订单必须 client_user_id 非空"（会阻塞历史订单的退款处理）
- [ ] 客户端（`fengyu-client`）登录 / 绑定门店流程优化（本 ticket 仅消费其结果，不动流程）
- [ ] "开单失败尝试监控 / 风控"
- [ ] WorkFine 同步历史顾客 `bound_store_id` 回填脚本（若 §5 count 结果超阈再开独立 ticket）

---

## 9 实施记录（2026-04-24 完成）

### 9.1 前置 count（§5 硬门槛）

| 维度 | 5434(admin 库) | 5433(云函数库) |
|---|---|---|
| `client_wechat_users` 总数 | 58,803 | 58,802 |
| `bound_store_id IS NULL` | 6 (0.01%) | 5 (0.009%) |
| 近 90 天活跃 + bound_null | 2 / 46,718 | 1 / 46,717 |
| 历史 `sale_orders.client_user_id IS NULL` | — | 全库 2 笔 |

远低于 §5 的 5% 阈值。**无需回填脚本，已直接上线 PR-A。**

### 9.2 Commit 清单（6 个，落地 dev 并推送远程）

| Hash | 类型 | 说明 |
|---|---|---|
| `eb94ffb` | feat(backend) | admin createOrder + staff order.js create/createRepayment/createConversion 加 CLIENT_NOT_REGISTERED 守卫；clientUserId 类型收窄为 string |
| `55f5946` | feat(backend) | admin searchCustomers + staff customer.search 分支 A 加 `bound_store_id IS NOT NULL` 过滤 |
| `7817f62` | test(admin) | orders.test/customers.test 覆盖新守卫 + searchCustomers 过滤；重命名 manualPhone 遗留 case |
| `b6f2a84` | feat(admin) | 开单页下线 manualPhone state 与 input + 灰色指引卡 + 按钮 disabled 收紧 |
| `5328ec2` | feat(staff) | order-create 页面未命中顾客 toast + `onStep0Next` 用 `wx.showModal` 阻断；recentCustomers 启动过滤空 id |
| `2e47321` | test(admin) | 新增 orders-require-registered.spec + 修正 orders-create-flow.spec 3 处 manualPhone fallback |

### 9.3 §2.5 订单类型守卫落地

| 订单类型 | 实施 |
|---|---|
| 销售单 / 内部单（createOrder） | ✅ 入口守卫（admin + staff） |
| 充值卡（createOrder 充值分支） | ✅ 入口守卫 + 充值卡原守卫文案对齐 |
| 转换单（createConversion） | ✅ 查顾客时校验 `bound_store_id` 非空（admin 已有，staff 新增） |
| 回款单（createRepayment） | ✅ 读原订单 `client_user_id` 为空时抛错 |
| 退款单（createRefund） | ⛔ 不改（保护历史订单清算，§5 已确认） |

### 9.4 §4 验收结果

| 项 | 状态 |
|---|---|
| admin `bun run test` | ✅ 34 files / 731 tests passed |
| admin `npx tsc --noEmit` | ✅ 无错误 |
| admin `bun run build` | ✅ 生产构建通过 |
| staff miniprogram `tsc --noEmit` | ✅ 无错误 |
| admin E2E `orders-require-registered.spec` | ⚠️ 未自动跑通（`auth.setup.ts` 登录跳转 timeout，与本 ticket 无关） |
| 员工端小程序手工验证 | ⏳ 待 staffApi 部署后人工跑四步开单流程 |
| 云函数部署 | ⏳ 待 `/cloudbase-deploy` |

### 9.5 后续 TODO

- [ ] `staffApi` 云函数部署到 CloudBase（`/cloudbase-deploy`）；部署后在微信开发者工具跑未注册手机号 → 看到 toast；onStep0Next → 看到 showModal
- [ ] 修复 E2E `auth.setup.ts` 登录 timeout：根因已定位 — 5434/fengyu 测试库中唯一 admin 账号是 `15958024944`（"测试员"），而 `auth.setup.ts:12` 硬编码 `13800138000` 不存在。独立于本 ticket，建议要么把 auth.setup 改为使用真实账号 + 已知密码，要么在测试库 seed 一个 `13800138000/admin123` 的测试账号
- [ ] admin 在灰色指引卡上线后，观察搜索"未命中"流量比，确认业务引流文案有效
