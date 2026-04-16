---
title: Client 端换绑手机号需求分析
date: 2026-04-16
status: 需求已对齐（R1/R2/R3/R5/R6 已定，R4 风控待定），P0 可启动开发
owner: 待分配
area: fengyu-client / cloudfunctions/clientApi / db / admin（可选）
related:
  - fengyu-client/cloudfunctions/clientApi/routes/auth.js (bindPhone)
  - fengyu-client/cloudfunctions/clientApi/middleware/auth.js (requirePhone, invalidateAuthCache)
  - fengyu-client/miniprogram/pagesProfile/profile-edit/profile-edit.{ts,wxml}
  - fengyu-client/miniprogram/pages/profile/profile.ts
  - db/schema/user.ts (client_wechat_users)
  - db/schema/order.ts (sale_orders.client_phone / pending unique)
  - db/schema/operation-log.ts (operation_logs)
---

## 🔑 前提与已决策项

### 前提 1 — WorkFine 同步已停
**正式运行后不会再执行 WorkFine 同步**（`db/scripts/sync-workfine.js` 仅用于历史
数据一次性迁移 + 上线前的定期刷新，正式上线后停止）。因此：

- `client_wechat_users.customer_id` 不会被同步脚本动态覆盖；
- WorkFine 同步导致的"档案被覆盖回旧值"风险**不存在**；
- 但**存量孤儿档案**（历史同步进来的 openid=NULL 行，约 5.8w 条中的绝大部分）
  **仍然在 PG 中**，换绑到这些号的场景依然是真实风险。

### 前提 2 — 业务语义（已决策）
> **"换手机号只是更改手机号这个字段，账号还是这个账号。"**

即采用 §4.1 的**语义 α — 跟人走**：

- openid/user_id 不变；
- 所有业务数据（积分 / 会员等级 / 顾客类型 / 消费档位 / 优惠券 / 充值卡 /
  历史订单 / 预约 / 消息 / 绑定门店 / 绑定美容师）**全部保留**；
- 仅 UPDATE `client_wechat_users.phone` 一个字段；
- 历史订单 `sale_orders.client_phone` 为下单时快照，**不回填**；
- `customer_id` 及其他 WorkFine 档案字段**保留原值**（账号即原账号）。

基于该决策，本 ticket 进入实现阶段只需要在 §4 中继续解决
**R3（匿名订单归并）、R4（风控）、R5（pending 冲突）、R6（前端刷新）** 四项。

# Client 端换绑手机号 — 需求与影响分析

## 1. 需求背景

顾客端（C端）已经在「我的 → 编辑资料」页面埋了「手机号（换绑）」按钮
（`fengyu-client/miniprogram/pagesProfile/profile-edit/profile-edit.wxml:44-55`），
但后端 `auth.bindPhone`（`routes/auth.js:81-162`）当前只实现了**首次绑定**的语义，
对**换绑**（old_phone → new_phone，两个都不为 null）的副作用处理不完整。

本 ticket 目的：
1. 梳理换绑涉及的所有联动与风险；
2. 对关键的歧义语义给出**需业务方决策的问题列表**；
3. 给出**推荐实现方案**与**分阶段落地计划**。

## 2. 现状分析

### 2.1 当前 bindPhone 行为（同一个 action 承载首次绑定 + 换绑）

关键代码路径：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:81-162`

```
1. 通过 OPENID 查出当前 client_wechat_users 行（一定存在，login 已建行）
2. 校验 新 phone 是否被"另一个 user_id"占用 → 占用则抛 INVALID_PARAMS
3. UPDATE client_wechat_users SET phone = 新号 WHERE user_id = 当前用户
4. invalidateAuthCache(OPENID)
5. UPDATE sale_orders SET client_user_id = 当前用户
   WHERE client_phone = 新号 AND client_user_id IS NULL
   （"历史匿名订单归并"逻辑）
```

### 2.2 已有的换绑 UI 入口

- `profile-edit.wxml:45-55` 有 `<button open-type="getPhoneNumber" bindgetphonenumber="onGetPhoneNumber">`
- `profile-edit.ts:105-125` 的 `onGetPhoneNumber` 调用同一个
  `bindPhoneWithCloudID(cloudID)`（`utils/cloud.ts:59-82`）
- 前端文案未区分"首次绑定"与"换绑"，成功 Toast 统一显示"绑定成功"或"已同步 N 笔历史订单"

### 2.3 手机号在业务侧的语义

停用 WorkFine 同步后，`client_wechat_users.phone` 仍承担**两种角色**，换绑会牵动两条链路：

| 角色 | 字段/索引 | 文件 |
| --- | --- | --- |
| A. 微信身份的联系方式 / 登录态 | `client_wechat_users.phone` (uq_client_users_phone) | db/schema/user.ts:20,71 |
| B. 订单快照 / 匿名单归并键 | `sale_orders.client_phone`（开单时写入 + bindPhone 回填） | db/schema/order.ts:53,93; routes/order.js:396-401; routes/card.js:262-266; routes/auth.js:148-154 |

（历史上还有一条 "WorkFine UPSERT 匹配键"，因同步停用，不再是动态风险，
但**历史孤儿档案存量仍在**，详见 §4.2。）

语义错位的后果：档案串号、历史订单错挂人、匿名开单被他人认领。

## 3. 影响面矩阵

以下"影响"=换绑一次之后，需要确认的状态是否正确。

### 3.1 数据库层

| # | 对象 | 影响 | 是否已自动处理 |
| --- | --- | --- | --- |
| D1 | `client_wechat_users.phone` 唯一约束 | 当前代码仅检查"别的 user_id 不能占用" | ✅ 已处理 |
| D2 | `client_wechat_users.customer_id`（WorkFine 顾客编号，历史静态字段） | 换绑后字段保留旧值，不再被同步覆盖。若业务方视为"该 user_id 的历史档案关联"可接受；若 admin 会按 customer_id 反查会误导 | ⚠️ 需要业务决策（清空 vs 保留） |
| D3 | `client_wechat_users` 的档案字段（name/gender/member_level/bound_store_id/skin_type 等） | 换绑后字段保留（跟 user_id 走）。在 α 语义下是正确的 | ✅ 跟 α 语义一致 |
| D4 | `client_wechat_users.points_balance` + `point_transactions` | 以 user_id 关联，换绑后不变 | ⚠️ 需要业务决策：是跟旧号（数据归属不变）还是重置（视为新身份）？ |
| D5 | `client_wechat_users.member_level`, `customer_type`, `spending_tier`, `became_member_at` | 同 D4，跟 user_id 走 | ⚠️ 需要业务决策 |
| D6 | `sale_orders.client_phone`（已开过的订单快照） | **按 v3.1 约定是快照**，换绑后旧订单的 client_phone 保留为旧号 | ✅ 这是正确的（快照语义） |
| D7 | `sale_orders.client_user_id`（已绑定的历史订单） | 不变 | ✅ 正确 |
| D8 | `sale_orders` pending unique `uq_sale_orders_phone_pending` | 当前用户的新号如果在同门店已有"匿名待支付单"，合并时会冲突 | ❌ 未处理边界（非常罕见但要兜底） |
| D9 | 现有匿名待支付单归并 `UPDATE ... client_user_id IS NULL` | **换绑场景下这一步变得危险**：如果新手机号曾被店员录入过其他顾客的匿名订单，换绑后会错误归并到当前 user | ❌ 危险 |
| D10 | `user_coupons.client_user_id` | 跟 user_id 走，不变 | ⚠️ 语义歧义（同 D4） |
| D11 | `prepaid_cards` / `card_transactions` | 以 user_id 关联 | ⚠️ 语义歧义（同 D4） |
| D12 | `appointments.client_user_id` / `client_name`（快照） | 以 user_id 关联，client_name 是快照 | ✅ 正确 |
| D13 | `service_orders` | 继承订单，无独立 phone 字段 | ✅ 正确 |
| D14 | `messages.client_user_id` | 跟 user_id 走 | ✅ 正确 |
| D15 | `store_unbind_requests` | 跟 user_id 走 | ✅ 正确 |
| D16 | `operation_logs`（审计） | 当前 `operator_employee_id` 仅支持员工 ID，客户端换绑这种**自助操作**无位置记录 | ❌ 审计缺口 |

### 3.2 云函数 / 接口层

| # | 接口 | 影响 |
| --- | --- | --- |
| A1 | `auth.bindPhone` | 承担两个语义（首次 + 换绑），逻辑分叉需要明确化 |
| A2 | `auth.login` | 返回 phone、memberLevel、boundStoreName，换绑后前端需要 refresh |
| A3 | `order.create` | 以 `ctx.auth.phone` 写入 `sale_orders.client_phone`（快照），换绑后新单用新号，旧单保留旧号 ✓ |
| A4 | `card.history / card.list` | 依赖 user_id，不变 |
| A5 | `requirePhone` 中间件 | 换绑期间的"同一会话"可能触发缓存脏读；现有代码已在 bindPhone 结束调用 `invalidateAuthCache(OPENID)`，OK |
| A6 | WorkFine 同步脚本 `db/scripts/sync-workfine.js` | **最大的联动风险源**（见 4.2） |

### 3.3 前端 / UI 层

| # | 位置 | 影响 |
| --- | --- | --- |
| U1 | `profile-edit.wxml:45-55` | 换绑按钮已存在，但缺二次确认、缺"后果提示" |
| U2 | `profile-edit.ts:105-125` `onGetPhoneNumber` | Toast 文案不区分首绑/换绑 |
| U3 | `pages/profile/profile.ts` | 有相同按钮（首绑场景）。建议：首页按钮仅作首绑、换绑统一走 profile-edit，避免两处逻辑分叉 |
| U4 | `app.ts` 登录态同步 | 换绑成功后需要 `syncLoginState()` 或把新 phone/memberLevel 回填 globalData + localStorage |
| U5 | 已下单页面（如 checkout）的"收货手机号"展示 | 若页面读取 `wx.getStorageSync('phone')`，换绑后需刷新 |

### 3.4 管理后台（fengyu-admin）

| # | 位置 | 影响 |
| --- | --- | --- |
| M1 | 顾客列表按 phone 搜索 | 用旧手机号搜不到历史（因为 phone 列被覆盖） |
| M2 | 顾客详情"绑定手机号" | 直接展示 client_wechat_users.phone，换绑后显示新号，没有 phone history |
| M3 | 订单列表里的 `client_phone` | 快照，仍显示下单时的旧号 ✓ |
| M4 | 审计/操作日志 | 无客户端换绑事件记录 |

## 4. 核心风险与歧义决策点

### 4.1 【决策 R1】换绑后身份归属 — ✅ 已决策 α（跟人走）

**已决策（2026-04-16）：** "换手机号只是更改手机号这个字段，账号还是这个账号。"

即：openid/user_id 不变，所有业务数据（积分 / 会员等级 / 顾客类型 / 消费档位 /
优惠券 / 充值卡 / 历史订单 / 预约 / 消息 / 绑定门店 / 绑定美容师 / customer_id）
**全部保留**，仅 UPDATE `client_wechat_users.phone` 一列。

历史订单 `sale_orders.client_phone` 为下单时快照，**不回填**（保留旧号）。

> 备选方案 β（跟号走 / 强合并）、γ（禁止换绑到已有档案的号）已被否决。

### 4.2 【决策 R2】与 WorkFine 同步的交互 — ✅ 已失效

正式运行后 WorkFine 同步不再跑，本决策项**作废**。

- `customer_id` 不会被同步覆盖，换绑后保留旧值即可；
- 无需在换绑事务内清空任何档案字段；
- 同步逻辑（sync-workfine.js）从风险面里移除，不再作为 §5.1 事务的考虑因素。

### 4.3 【决策 R3】历史匿名订单归并（auth.js:148-154）

当前无脑 `UPDATE sale_orders ... WHERE client_phone = new_phone AND client_user_id IS NULL`。
首次绑定下是合理的（把员工录入的匿名开单认领给当前微信）。
**换绑下是危险的**：别人的匿名单可能被顶替绑到当前用户。

**建议**：
- 若本次是换绑（`old_phone != null`），**只归并那些最近 N 小时内新创建的匿名单**
  （例如 24 小时），并限制同门店、限制条数；
- 或者直接：换绑场景下**禁用**自动归并，提示用户联系门店店员手工处理。

### 4.4 【决策 R4】换绑频率、风控、验证强度

- 微信 `getPhoneNumber` 拿到的 CloudID 只能证明"当前微信账号能看到这个手机号"，
  不能证明所有权（例如家人、离职员工等）。
- 考虑**限流**：N 天内最多换绑 M 次（建议 30 天 / 3 次，可配置）。
- 考虑**高风险拦截**：
  - 新号 = 门店员工绑定号 → 拒绝
  - 新号 30 天内有其他 openid 刚解绑 → 二次确认或冷静期
- 考虑**审计**：每次换绑写 `operation_logs`，source='clientApi'，
  target_type='client_user'，target_id=user_id，detail={oldPhone, newPhone, cloudIdAt}。
  （注意现表结构 `operator_employee_id` 不允许客户端用户；需要迁移加可选
  `operator_client_user_id` 或 source='clientApi' 时允许 operatorEmployeeId 为 null）

### 4.5 【决策 R5】待支付订单的冲突（D8）

若当前微信已有同门店的 pending 销售单（`status='待支付'` 且 `client_user_id=当前`），
且换绑后新号又恰好挂着一张同门店的匿名 pending 单（`client_user_id IS NULL` 且
`client_phone = new_phone`），归并会违反
`uq_sale_orders_phone_pending`（其实不会触发，因为这个约束的 where 是
`client_user_id IS NULL`；归并后匿名单的 client_user_id 不再为空，就从这个约束里退出了）。

但是会激活另一个约束 `uq_sale_orders_client_pending`（where `client_user_id IS NOT NULL`）：
**一个 user 同门店只能有一张 pending**。**这里需要处理**：

- 方案 a：拒绝归并，保留旧的 pending 单不动，要求顾客先付款/关闭某一张；
- 方案 b：把匿名单直接关闭（`status='已关闭'`）；
- 方案 c：把当前用户的旧 pending 关闭。

建议 **a**（最小惊讶原则，通过提示让用户自己选）。

### 4.6 【决策 R6】前端会话刷新

换绑成功后，以下要失效：
- `wx.getStorageSync('phone')` → 写入新号
- `app.globalData.userInfo` 中的 phone
- clientApi 的 `AUTH_CACHE`（已由 `invalidateAuthCache` 处理）
- 页面数据（profile-edit.maskedPhone 已处理，profile.ts 的 refreshData 要改）

## 5. 推荐实现方案

### 5.1 接口约定

新增独立 action（与 `bindPhone` 明确分离），降低语义耦合：

```
auth.rebindPhone
  输入：phoneData (CloudID)
  规则：
    - 要求 ctx.auth.phone 非空（首次绑定走 bindPhone）
    - 新号 = 老号 → 幂等成功，直接返回
    - 新号已被其他 user_id 占用 → INVALID_PARAMS: 该手机号已被其他账户使用
    - 新号属于员工 phone → PERMISSION_DENIED（可选风控）
    - 30 天内换绑次数 >= 3 → RATE_LIMIT（可选风控）
  执行（单事务）：
    1. 读 client_wechat_users 当前行（含 customer_id、phone）
    2. 检查新号在 client_wechat_users 里是否已存在另一条独立"孤儿"档案
       （phone = new_phone AND openid IS NULL）
       → 若存在：进入 5.2 决策路径（当前先报 NEEDS_CUSTOMER_SUPPORT，让客服处理）
    3. UPDATE phone = new_phone（仅此一列）
       customer_id / member_level / points / bound_store_id / 档案字段 **全部保留**。
       历史订单的 client_user_id / client_phone 不动。
    4. 审计日志（见 5.4）
    5. 处理匿名订单归并（见 5.3，仅在允许时执行）
    6. invalidateAuthCache(OPENID)
  返回：{ success: true, phone: new, oldPhone: old, mergedAnonymousOrders: N }
```

保留 `auth.bindPhone` 只处理 **首次绑定**；在服务端强制检查：若 `ctx.auth.phone` 非空，
bindPhone 返回 `INVALID_PARAMS: 已绑定手机号，请使用换绑功能`。

> 过渡期可让 `bindPhone` 在 `ctx.auth.phone` 非空时**内部转调** `rebindPhone`
> 以兼容既有小程序客户端，但要在 operation_logs 里标明 via=legacy-bind。

### 5.2 新号已有"孤儿档案"的处理

孤儿档案 = `client_wechat_users WHERE phone = new_phone AND openid IS NULL`，
**均来自历史 WorkFine 同步时创建的顾客档案**（因同步已停，存量固定，不会新增）。

这类行上挂着的不只是 phone，还可能有：customer_id、历史会员等级、消费档位、
历史订单（通过 user_id 关联）、充值卡、积分等。简单 "UPDATE phone=new_phone
WHERE user_id=当前" 会因 `uq_client_users_phone` 冲突而失败，
且即便成功也会让那条孤儿行的业务数据**成为无法访问的死数据**。

**MVP 实现（与 α 语义一致，最保守）**：

- 换绑事务内先检测 `SELECT 1 FROM client_wechat_users WHERE phone = new_phone AND user_id != 当前`；
- 命中即拒绝，返回错误码 `PHONE_HAS_EXISTING_PROFILE`，文案：
  "该手机号在我们系统中已存在消费档案。为避免数据错乱，请联系门店协助处理。"
- 业务备注：虽然现有代码 `auth.js:130-136` 已有"被其他 user_id 占用"的校验并返回
  "该手机号已被其他用户绑定"，但该文案对"孤儿档案"（openid=NULL，并非另一个活跃用户）
  用户误导性强；应细分为**两种错误码**：
  - `PHONE_BOUND_BY_OTHER_USER`（目标行有 openid，是另一个活跃微信账号）
  - `PHONE_HAS_EXISTING_PROFILE`（目标行 openid 为 NULL，是历史档案）
  两类场景的处理方式相同（都拒绝），但文案区分，便于客服定位。

**后续迭代（P1/P2，不在本 ticket 范围）**：

- admin 端"顾客合并工具"：把孤儿行的 customer_id / member_level / 历史订单等
  业务数据迁移到当前微信用户的行，再删除孤儿行。该工具同样能解决 α 语义下的
  历史档案认领问题。
- 客户端"检测到历史档案，是否认领合并"的自助流程需要身份核验（如门店员工扫码确认），
  目前不实现。

### 5.3 匿名订单归并规则（换绑场景）

**方案 A（保守，推荐 MVP）**：换绑**不触发**匿名订单归并。
理由：换绑时用户已经是老用户，匿名归并属于首绑场景的"把过去的匿名单找回来"
特性，对换绑没有同样的合理性。

**方案 B（若业务要保留）**：仅归并
- `client_phone = new_phone` 且
- `client_user_id IS NULL` 且
- `created_at > now() - interval '24 hours'` 且
- `store_id = ctx.auth.boundStoreId`（仅限当前绑定门店）

两种方案都要返回 `mergedAnonymousOrders` 计数便于前端展示。

### 5.4 审计

- 在 `operation_logs` 中新增/补写一行：
  ```
  source = 'clientApi'
  action = 'auth.rebindPhone'
  target_type = 'client_user'
  target_id = userId
  detail = { oldPhone: '138***1111', newPhone: '139***2222',
             customerIdCleared: 'FY-GK-XXX', mergedOrders: 0, viaLegacyBind: false }
  operator_employee_id = NULL   ← 当前 FK 不允许 NULL 时要迁移 schema
  operator_name = '顾客自助'
  ```

- schema：`operator_employee_id` 已经是**可空** FK（见 db/schema/operation-log.ts:16），
  无需迁移；MVP 直接用 `NULL + detail.clientUserId` 的方式记录即可。
  是否增设 `operator_client_user_id` 列放 P1 评估。

- 手机号脱敏：`detail` 里的 oldPhone/newPhone 使用 `maskPhone` 存储，防止审计表泄密。

### 5.5 前端改造

1. `profile-edit.wxml` 手机号行：
   - 首绑（`maskedPhone` 为空）：按钮文案"立即绑定"、onGetPhoneNumber 调 `auth.bindPhone`
   - 已绑定：点击弹 `van-dialog` 二次确认：
     "换绑后新手机号将用于登录、下单联系、会员识别，确认继续？"
     确认后才触发 `open-type="getPhoneNumber"` 弹窗
     （注意：微信 getPhoneNumber 按钮必须直接是 `<button>`，
     二次确认可做成"先点一次普通按钮弹 dialog → 确认 → 再显示绑定按钮"的两步式）

2. `profile-edit.ts`：
   - 新增 `isRebind = computed(!!maskedPhone)`
   - `onGetPhoneNumber` 根据 isRebind 调不同 action
   - 成功后 Toast 文案差异化；调 `app.syncLoginState()` 刷新 globalData +
     localStorage（phone、memberLevel 等）

3. `pages/profile/profile.ts`：
   - 把"换绑"统一导去 profile-edit 页（避免两处入口）
   - 首绑入口保留

4. `utils/cloud.ts`：
   - 新增 `rebindPhoneWithCloudID(cloudID)`，与 `bindPhoneWithCloudID` 并列
   - 或在 `bindPhoneWithCloudID` 里根据本地 `wx.getStorageSync('phone')` 自动选 action

5. 受 phone 影响的页面刷新：
   - checkout、card-recharge、profile 等页从 globalData 读取
   - 保证换绑成功后：`app.globalData.userInfo.phone = newPhone`
     + `wx.setStorageSync('phone', newPhone)`

### 5.6 数据库

MVP 不需要 schema 迁移（只用现有字段 + operation_logs.detail）。

后续（P2）考虑：
- `client_wechat_users.phone_history jsonb`（或独立表 `client_phone_history`）
  存 `[{phone, changed_at, changed_by}]`，便于 admin 按旧号反查。
- `operator_client_user_id` 字段（见 5.4）。

## 6. 分阶段落地计划

### P0（本 ticket 范围 — MVP）
- [ ] 后端：`auth.rebindPhone` action（单事务：仅 UPDATE phone 一列 + 审计）
- [ ] 后端：`auth.bindPhone` 在 `ctx.auth.phone` 非空时返回 `INVALID_PARAMS`
      或内部转调 `rebindPhone`（二选一）
- [ ] 后端：换绑时**禁用**匿名订单归并（方案 A）
- [ ] 后端：细分错误码 `PHONE_BOUND_BY_OTHER_USER` / `PHONE_HAS_EXISTING_PROFILE`
- [ ] 前端：profile-edit 二次确认 + 首绑/换绑文案区分
- [ ] 前端：换绑成功后刷新 globalData + localStorage（phone 一列即可）
- [ ] 前端：pages/profile 移除重复的换绑入口
- [ ] 测试：单测覆盖 新号=旧号幂等 / 新号被活跃用户占 / 新号为孤儿档案 / 审计写入 / 匿名归并未触发
- [ ] 测试：手机号 mask 脱敏写入 operation_logs

### P1（1-2 周内）
- [ ] 换绑限流（30 天 3 次）配置化
- [ ] admin 顾客合并工具（孤儿档案认领）
- [ ] admin 顾客详情增加"手机号变更日志"Tab
- [ ] 评估是否需要 `operation_logs.operator_client_user_id` 字段

### P2（长期）
- [ ] `client_phone_history` 独立表
- [ ] "合并到已有档案"的自助流程（带门店身份核验）

## 7. 测试用例清单（供 P0 对齐）

### 7.1 正向
- TC01 已绑定 138xxx1111，换绑到全新号 139xxx2222 → 成功，客户所有券/积分/会员保留
- TC02 换绑到和当前号一致 → 返回成功（幂等）
- TC03 换绑后立即调 `auth.login` → 返回新 phone
- TC04 换绑后立即调 `order.create` → 新单 `client_phone` = 新号
- TC05 换绑后历史订单 `client_phone` = 旧号（快照未变）

### 7.2 负向
- TC10 未绑定就调 rebindPhone → UNAUTHORIZED / PHONE_REQUIRED
- TC11 新号被其他 user_id 占用 → INVALID_PARAMS
- TC12 新号为孤儿档案（phone 已存在、openid=null）→ NEEDS_CUSTOMER_SUPPORT
- TC13 CloudID 解密失败 → INVALID_PARAMS
- TC14 30 天内第 4 次换绑 → RATE_LIMIT（若启用限流）
- TC15 新号为员工绑定号 → PERMISSION_DENIED（若启用）

### 7.3 身份/会员数据保留（α 语义核查）
- TC20 换绑前积分 5000 → 换绑后 `points.balance` 仍为 5000
- TC21 换绑前 member_level = 粉钻 → 换绑后等级不变
- TC22 换绑前有优惠券 3 张、充值卡 2 张 → 换绑后全部保留
- TC23 换绑前 customer_id = 'FY-GK-001' → 换绑后 customer_id 不变

### 7.4 审计
- TC30 换绑后 operation_logs 新增 1 条，detail.oldPhone/newPhone 已脱敏
- TC31 admin 顾客详情可看到该条日志

### 7.5 前端
- TC40 点击换绑按钮弹二次确认，取消后不触发微信授权
- TC41 换绑成功 Toast 显示"已换绑至 139****2222"
- TC42 换绑后 profile 页、checkout 页读取的 phone 是新号
- TC43 换绑失败（NEEDS_CUSTOMER_SUPPORT）时显示完整客服提示文案

## 8. 决策状态

| 决策项 | 结论 | 备注 |
| --- | --- | --- |
| **R1 身份归属** | ✅ 采用语义 α（账号不变，只改 phone） | 2026-04-16 业务方确认 |
| **R2 WorkFine 联动** | ✅ 已失效 | 正式运行后不再跑同步 |
| **R3 匿名归并** | ✅ 换绑禁用匿名订单归并（方案 A） | 与 α 一致：历史订单不动 |
| **R4 风控** | ⚠️ 待定（建议 30 天 3 次 + 拦截员工号） | 可放 P1 |
| **R5 Pending 单冲突** | ✅ 已失效 | 方案 A 下 pending 单归并不触发 |
| **R6 孤儿档案** | ✅ MVP 拒绝换绑，返回专用错误码引导客服 | 不合并业务数据 |
| **P1 admin 合并工具** | ⚠️ 待定 | 取决于孤儿档案被拒后的客诉量 |

## 9. 关联 / 参考

- `.42cog/pm/client.pr.spec.md` — 客户端产品需求（需补充换绑章节）
- `.42cog/real.md` — 现实约束（customer_id 与 phone 的主从关系）
- `project_staff_data_ownership.md` — 员工端类似的合并/同步逻辑可借鉴
- `feedback_no_legacy_compat.md` — 本项目开发阶段不需要历史兼容，
  因此 `auth.bindPhone` 内部转调 `rebindPhone` 的兼容层可省略，直接让前端改用新 action
