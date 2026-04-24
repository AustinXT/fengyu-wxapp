# Ticket: 分享礼 — 老用户邀请新客首单互赠代金券

> 生成日期：2026-04-24
> 严重级别：P2（增长玩法新增；无线上 bug，但跨 db + 小程序 + 3 个云函数 + admin 共 9 个目录，属于典型跨端变更）
> 端：fengyu-client 小程序 + fengyu-client/cloudfunctions + fengyu-staff/cloudfunctions + fengyu-admin + db
> 影响面：
>   - `db/schema/user.ts` — 新增 `inviter_user_id` + `invited_at`
>   - `db/schema/coupon.ts` — 新增 `user_coupons.face_value_override`
>   - `db/migrations/0007_*.sql` — 两列 + 约束 + 部分索引
>   - `fengyu-client/miniprogram/app.ts` — onLaunch / onShow 解析分享 query
>   - `fengyu-client/miniprogram/app.d.ts` / `typings/global.d.ts` — `globalData.pendingInviter`
>   - 多个 `onShareAppMessage` 调用点 — `path` 带 `?inv={userId}` 参数（至少首页 / 下单页 / 订单详情）
>   - `fengyu-client/cloudfunctions/clientApi/routes/auth.js` — `bindStore` 接 `inviterUserId`
>   - `fengyu-client/cloudfunctions/clientApi/routes/order.js` — 储值卡全额抵扣路径按规则跳过发放；无新增路由
>   - `fengyu-client/cloudfunctions/clientApi/routes/coupon.js` — `coupon.list` / `coupon.available` 读取时 `COALESCE(face_value_override, discount_value)`
>   - `fengyu-client/cloudfunctions/payNotify/index.js` — 事务内调用 `grantShareGift`
>   - `fengyu-staff/cloudfunctions/staffApi/routes/order.js` — `confirmOffline` 事务内调用 `grantShareGift`
>   - `fengyu-admin/src/app/(main)/share-gift/` — 新建运营配置页
>   - `fengyu-admin/src/actions/settings.ts` — 读写 `system_configs.share_gift_config`
>   - `fengyu-admin/src/app/(main)/coupons/` — 无改动（复用现有模板创建；分享礼券通过普通模板 + 运行时 override 实现）
>
> 前置依赖：**无强依赖**。可与以下 ticket 并行：
>   - `2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`（生日/升级幂等通道已由 0006 migration 落地，本 ticket 用同样模式）
>   - `2026-04-24-member-birthday-benefits.md` / `2026-04-24-member-thanksgiving-benefits.md`
>   - `2026-04-24-multi-repayment-three-ends.md`（回款路径已多次改造；本 ticket 需在已合并基础上给 `payNotify` / `confirmOffline` 追加 hook，但不改回款核心逻辑）
>   - `2026-04-24-refund-admin-parity-and-rules.md`（退款 MVP 不回收分享礼券，规避竞态）
>
> **一句话目标**：让被分享人首单结清时，按 `paid_amount × 15%` 向邀请人和新客**各发一张动态面值代金券 + 一条站内消息通知**；跨三条支付结清路径（微信/支付宝/线下/储值卡-跳过）都触发；以 `sale_order_id` 为幂等根键做到零重复。
>
> **双交付契约**（本 ticket 必须同时达成，缺一视为未完成）：
>   1. `user_coupons` 2 行（面值 = paid_amount × percent clamp 到 [min, max]）
>   2. `messages` 2 行（给邀请人 / 给新客各一条站内通知，走 `messages.idempotency_key` 幂等）

---

## 0 一句话背景

需求原文：
> 分享礼：老用户邀请新用户来下单，根据新客首单的 paid_amount，分别向新、老用户发放 paid_amount*15% 金额的代金券。

调研发现仓库现状：**所有基础设施都在、逻辑未接**。

| 模块 | 现状 | 关键位置 |
|---|---|---|
| 代金券模板 + 用户券发放通道 | ✅ 完整 | `db/schema/coupon.ts:11-75`（couponTemplates / userCoupons），`cronTask/index.js:180-230`（grantUpgradeBenefits 参考实现） |
| 客户端 → 客户端 邀请关系字段 | ❌ **不存在** | `db/schema/user.ts:43` 只有 `promoter_employee_id`（员工推荐） |
| 券的运行时动态面值能力 | ❌ **不存在** | `couponTemplates.discountValue` 是固定值；`userCoupons` 无 override 列 |
| 小程序分享链路带参数 | ❌ **未实现** | `onShareAppMessage` 散落多处但 `path` 无参数（如 `/pages/home/home`）；`App.onLaunch` 也未解析 query |
| 三条支付结清路径统一触发 hook | ❌ **不存在** | `payNotify / confirmOffline / 储值卡抵扣` 三处各自处理副作用，无公共 hook |
| messages 幂等键 | ✅ 已落地 | `messages.idempotency_key` + `uq_messages_idempotency_key`（migration 0006_wonderful_earthquake.sql） |
| operation_logs 审计通道 | ✅ 完整 | `operation-log.ts`；已有 `'customer.memberLevelChange'` 等前例 |
| system_configs 存储 | ✅ 完整 | 已有 `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits`，新增 key 即可 |
| admin 运营配置页 | ❌ 本场景不适用会员权益页（形态不同） | `fengyu-admin/src/app/(main)/member-benefits/` 是五档×三件套，分享礼是"开关+比例+券模板+有效期"，需独立新页面 |

**这是一个纯新增增长玩法**：不改已有业务流，只在三处支付结清事务内挂一个 hook，+ 2 列 schema，+ 1 个 admin 配置页，+ 小程序分享参数传递。

---

## 1 问题定位

### 1.1 缺口一：客户-客户邀请关系缺字段

`client_wechat_users.promoter_employee_id` 引用的是 **员工**（美容师带客），不能复用到"客户带客户"。且 `auth.bindStore` 已经在消费 `promoterEmployeeId` 写入 `promoter_employee_id`（clientApi/routes/auth.js:203），语义不能重载。

**方案**：新增 `client_wechat_users.inviter_user_id TEXT` + FK → 自身。

### 1.2 缺口二：券面值无法运行时计算

`coupon_templates.discountValue numeric(10,2)` 是模板固定面值。分享礼的面值 = 新客首单 paid_amount × 15%，每次都不一样。

三种扩展方案：
- A1. 运营预建 5/10/20/50/100 元 5 档模板，按 paid_amount×15% 向下取整到最近挡 — **精度差**，与运营沟通成本高
- **A2. `user_coupons.face_value_override numeric(10,2) NULL`**，发券时写入实际金额；读取点 `COALESCE(face_value_override, template.discount_value)` — **推荐**
- A3. `coupon_templates.value_formula jsonb` — **过度设计**，当前只有一个动态场景

采用 A2。读取点 3 处：`coupon.list` / `coupon.available` / 订单抵扣结算。

### 1.3 缺口三：小程序分享链路未带邀请人参数

现状（调研结果）：
- 多个页面实现了 `onShareAppMessage`（checkout / orders / order-detail 等），但 `path` 硬编码 `/pages/home/home`，不带任何 query
- `App.onLaunch` 仅做 init cloud、计算导航栏、恢复缓存、同步登录（`miniprogram/app.ts:18-26`），**不解析** `getLaunchOptionsSync().query` 和 `onLaunch(options)` 参数

**方案**：
- App.onLaunch / onShow 新增 query 解析：`if (q.inv) app.globalData.pendingInviter = q.inv`
- 修改 `onShareAppMessage`：`path: '/pages/home/home?inv=' + userId`（多处）
- `auth.bindStore` 入参扩 `inviterUserId`，仅当当前 `inviter_user_id IS NULL` 时写入（**一次写死**）

### 1.4 缺口四：首单判定 ≠ 订单内"首次支付"

`payNotify/index.js:149-154` 与 `staffApi/order.js:825-832` 已经有 `changeType='首次支付' / '回款'` 逻辑，但那是 **单一订单内语义**（这笔订单是首次收到款还是后续回款）。**顾客首单**（该用户所有订单中的第一笔结清订单）是另一个概念。

SQL 判定（D4 推荐方案）：
```sql
SELECT COUNT(*)::int AS c FROM sale_orders
 WHERE client_user_id = $1
   AND status IN ('已支付','已完成')
   AND sale_order_id <> $2
```
`c = 0` ⇒ 当前订单是该顾客的首单。

**关键约束**：判定时机在订单 `status` 从非终态 → '已支付' / '已完成' 的瞬间（即事务内完成 UPDATE 后立刻查询）。若当前订单尚未 commit，自身不会被计入 `<>` 排除的其他订单集合。

**部分支付情形**：订单若经历 `'待支付' → '部分支付' → '已支付'` 的多段回款，只有最后一次回款触发；中间的 '部分支付' 状态不算结清，不触发。

### 1.5 缺口五：admin 无分享礼运营配置入口

现有 `fengyu-admin/src/app/(main)/member-benefits/` 是五档 × 三件套的权益配置，共用 `MemberLevelBenefitsForm`，**形态不适用**于"开关 + 百分比 + 券模板 + 有效期"的单一配置。

**方案**：新建页面 `fengyu-admin/src/app/(main)/share-gift/` + 对应 `_components/share-gift-page.tsx` + `settings.ts` 新增 `getShareGiftConfig / updateShareGiftConfig` Server Actions。

---

## 2 用户确认的规则（决策基准线）

| # | 规则 | 决策 | 理由 |
|---|---|---|---|
| 1 | 面值动态化方案 | **A2：`user_coupons.face_value_override`**；读取处 `COALESCE(override, discount_value)` | 精度完全匹配原文"paid_amount×15%"；改动可控（1 列 + 1 处发券逻辑 + 3 处读取） |
| 2 | 邀请关系存储 | **B1：`client_wechat_users.inviter_user_id TEXT` + FK → 自身 + CHECK(inviter_user_id ≠ user_id)**；加 `invited_at TIMESTAMP` 审计。**只允许一次写入**（后续调用 UPDATE ... WHERE inviter_user_id IS NULL） | 1:1 关系够浅，不需要独立表；一次写死防止事后改邀请人套取奖励 |
| 3 | 邀请人绑定时机 | **C1：首次进入小程序时捕获 `inv` query → globalData.pendingInviter → `auth.bindStore` 时写入** | 入口即绑定，闭环；下单时才绑容易被老用户事后补邀请人套利 |
| 4 | 首单判定 | **D1：`COUNT(*)` SQL 判**，在订单 `status` 进入 '已支付' / '已完成' 的事务内同步执行 | 无需新增冗余列；现有索引 `idx_sale_orders_store_status` 查询够快 |
| 5 | 触发覆盖范围 | **E1：三处都触发** — payNotify + staffApi.confirmOffline + clientApi.order.create（储值卡路径按 §2 决策 #10 跳过） | 否则线下和储值卡用户拿不到券，产品体验裂缝 |
| 6 | 共享发券函数的代码组织 | 每个云函数目录复制一份 `share-gift.js`（payNotify / staffApi / clientApi 各一份）| CloudBase 跨云函数共享代码受限（相对路径、打包），每份 ≤80 行可接受；未来若做 shared-layer 再统一 |
| 7 | 运营配置化 | **F1：`system_configs.share_gift_config` JSON**（enabled / percent / minFaceValue / maxFaceValue / couponTemplateId / validityDays / inviterMustHavePaidOrder / 4 条消息文案） | 对齐现有 `member_level_benefits` 模式；admin 新建 `/share-gift/` 独立页面 |
| 7.1 | **消息通知强制双发** | 邀请人 + 新客**各发一条 `messages` 行**，与发券原子同事务；即使 `messageInviterTitle` / `messageInviteeTitle` 其一为空也视为运营配置不完整，后端 console.warn + 不发该条但另一条照常发；**不允许**"静默发券不通知" | 分享礼的感知主要靠消息通知—如果只发券不通知，用户打开 my-coupons 页才能发现，社交传播效果大打折扣；消息文案运营可自定义，但标题为空时函数会打告警日志便于巡检 |
| 7.2 | 消息文案占位符 | 支持 `{paidAmount}` / `{couponValue}` / `{validityDays}`；渲染逻辑见 §5.2 第 9 步；admin 配置页提供实时预览 | 避免硬编码金额；运营填模板字符串即可 |
| 7.3 | 消息幂等键 | `sg-msg-inviter-{orderId}` / `sg-msg-invitee-{orderId}`，走 `messages.idempotency_key` 部分唯一索引（migration 0006 已落地） | 回调重试、事务重跑均不重复推送 |
| 7.4 | 订阅消息 / 模板消息推送 | **不在本 ticket**；仅写站内 `messages` 表 | 微信推送链路独立，需要额外模板 ID 审核、订阅授权等，另开 ticket |
| 8 | 面值上下限兜底 | **G1：clamp(min=1, max=500)**，默认运营可调 | 避免 0.15 元这种无感券（5000 单以上 minSpend 10 元的券抵 0.15 体验差）；避免 20000 元套餐单发出 3000 元券被薅 |
| 9 | 邀请人资格 | **H1：`inviterMustHavePaidOrder = false`（默认关）**，配置项留位 | MVP 先放开观察；业务方若发现刷单再打开 |
| 10 | 储值卡全额抵扣订单 | **I1：`paid_amount > 0` 作为前置条件，= 0 直接 return**，不发分享礼 | 新客未掏真金白银，不构成"分享下单"业务闭环；admin 运营文案同步说明 |
| 11 | 部分支付场景 | 仅在 `status` 进入 '已支付' / '已完成' 时触发，'部分支付' 不触发 | 结清才算首单完成；以 `sale_order_id` 为幂等键保证只发一次 |
| 12 | 幂等键设计 | 以 `sale_order_id` 为根：券 `sg-inviter-{orderId}` / `sg-invitee-{orderId}`；消息 `sg-msg-inviter-{orderId}` / `sg-msg-invitee-{orderId}`；operation_logs 一条 `action='share.giftGranted'` | 订单 ID 唯一，天然满足"一单一礼"；回调重复、事务重试均幂等 |
| 13 | 退款回收 | **J1：MVP 不回收**，新客首单退款后券不回收 | 复杂场景（部分退 / 券已使用 / 券已叠加），另开 ticket；运营承担损失 |
| 14 | 邀请人 = 被邀请人防刷 | DB 层 CHECK + 业务层再校验（写入前 inviter ≠ 自身 user_id） | 双重兜底，分享链接未登录时先走登录再绑定，自己分享给自己会被挡 |
| 15 | 月度 / 总邀请上限 | **不做**（MVP），如需加再扩 config | 首期观察，避免过早优化 |
| 16 | 多级邀请 / 裂变链 | **不做**，只记直接邀请人 | 合规 + 反传销考虑 |
| 17 | 员工邀请 | **不做**，`promoter_employee_id` 已覆盖员工带客 | 本 ticket 聚焦"客户带客户" |
| 18 | 配置缺失容错 | `share_gift_config` 不存在 / `enabled=false` → `grantShareGift` 直接 return，不影响主流程 | 运营未配置 ≠ 报错中断 |

---

## 3 Schema 变更

### 3.1 新增列 + 约束

**迁移文件**：`db/migrations/0007_<drizzle_random_name>.sql`（由 `npm run db:generate` 生成，编号取决于生成时点）

```sql
-- client_wechat_users
ALTER TABLE "client_wechat_users"
  ADD COLUMN "inviter_user_id" text,
  ADD COLUMN "invited_at" timestamp;

ALTER TABLE "client_wechat_users"
  ADD CONSTRAINT "client_wechat_users_inviter_user_id_fkey"
  FOREIGN KEY ("inviter_user_id") REFERENCES "client_wechat_users"("user_id");

ALTER TABLE "client_wechat_users"
  ADD CONSTRAINT "chk_inviter_not_self"
  CHECK (inviter_user_id IS NULL OR inviter_user_id <> user_id);

CREATE INDEX "idx_client_users_inviter"
  ON "client_wechat_users" ("inviter_user_id")
  WHERE "inviter_user_id" IS NOT NULL;

-- user_coupons
ALTER TABLE "user_coupons"
  ADD COLUMN "face_value_override" numeric(10, 2);
```

### 3.2 Drizzle schema 变更

`db/schema/user.ts:43` 附近（promoterEmployeeId 下方）：
```ts
/** 客户邀请人（分享礼场景）；首次绑定时写入，写入后不变 */
inviterUserId: text('inviter_user_id').references((): any => clientWechatUsers.userId),
/** 成为被邀请人的时间戳（审计） */
invitedAt: timestamp('invited_at'),
```

`db/schema/coupon.ts:68` 附近（expireAt 下方）：
```ts
/** 分享礼等运行时动态面值场景写入；NULL 时使用 template.discount_value */
faceValueOverride: numeric('face_value_override', { precision: 10, scale: 2 }),
```

**两库迁移**（参考 `db/CLAUDE.md`）：
```bash
npm run db:migrate                                                            # 5434 测试库
DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
  npm run db:migrate                                                          # 5433 开发库（云函数用）
```

### 3.3 `share_gift_config` system_configs 初值

admin 配置页首次保存时 UPSERT 写入；若尚未配置，grantShareGift 读到 NULL → 直接 return（enabled=false 等价）。

---

## 4 小程序前端改造

### 4.1 App 层：捕获分享参数

`fengyu-client/miniprogram/app.ts`：
```ts
onLaunch(options: WechatMiniprogram.App.LaunchShowOption) {
  const inv = options?.query?.inv
  if (inv && typeof inv === 'string' && inv.startsWith('FYGK-')) {
    this.globalData.pendingInviter = inv
  }
  // ...原逻辑
},
onShow(options: WechatMiniprogram.App.LaunchShowOption) {
  const inv = options?.query?.inv
  if (inv && !this.globalData.pendingInviter && inv.startsWith('FYGK-')) {
    this.globalData.pendingInviter = inv
  }
},
```

`miniprogram/typings/global.d.ts` 或 `app.d.ts`：
```ts
interface IAppOption {
  globalData: {
    // ... 原有字段
    pendingInviter?: string
  }
}
```

### 4.2 onShareAppMessage 附带参数

对**每一处** `onShareAppMessage`（首页 / 订单列表 / 订单详情 / 下单结算页 / 商品详情 / 顾客个人中心等；grep 全量修改），path 改为：
```ts
onShareAppMessage() {
  const app = getApp()
  const userId = app.globalData.userId  // 已登录的老用户自身 userId
  const inv = userId ? `?inv=${encodeURIComponent(userId)}` : ''
  return {
    title: '凤御美容',
    path: `/pages/home/home${inv}`,
    imageUrl: '/assets/share-cover.png',  // 若已有分享封面
  }
}
```

未登录用户分享出的链接不带 inv（不构成邀请，被分享人 bindStore 时 pendingInviter 为空 → 不绑定）。

### 4.3 bindStore 绑定时写入 inviter

`clientApi.bindStore` 调用前，上游页面（`pages/bind-store/bind-store.ts` 或同等）从 `app.globalData.pendingInviter` 读取，拼进请求体：
```ts
const inviter = app.globalData.pendingInviter
await callClientApi('auth.bindStore', {
  storeId, sourceChannel, promoterEmployeeId,
  inviterUserId: inviter || undefined,
})
// 请求完成后清空（防止二次绑定重复尝试）
app.globalData.pendingInviter = undefined
```

### 4.4 coupon.list 前端渲染

`pagesC/my-coupons/my-coupons.ts` 渲染时从后端返回的 `displayFaceValue`（由云函数计算 `COALESCE(override, discount_value)`）展示，无需前端再计算。

---

## 5 云函数改造

### 5.1 clientApi.auth.bindStore 接 inviter 参数

`fengyu-client/cloudfunctions/clientApi/routes/auth.js` 的 bindStore action：
```js
const { storeId, sourceChannel, promoterEmployeeId, inviterUserId } = payload || {}
// ...既有校验

// 新增：邀请人一次性绑定（仅当自身 inviter_user_id IS NULL 且 inviter ≠ self 且 inviter 存在）
if (inviterUserId && typeof inviterUserId === 'string' && inviterUserId !== userId) {
  await client.query(
    `UPDATE client_wechat_users
        SET inviter_user_id = $1, invited_at = NOW()
      WHERE user_id = $2
        AND inviter_user_id IS NULL
        AND EXISTS (SELECT 1 FROM client_wechat_users WHERE user_id = $1)`,
    [inviterUserId, userId]
  )
}
```
不强校验 inviter 是否存在 / 有效（EXISTS 子查询保底，不存在则 UPDATE 0 行，不报错）。

### 5.2 共享 `grantShareGift()` 函数

落在 3 处：
- `fengyu-client/cloudfunctions/payNotify/share-gift.js`
- `fengyu-client/cloudfunctions/clientApi/share-gift.js`（仅用于储值卡全额抵扣路径的前置跳过判断，可选）
- `fengyu-staff/cloudfunctions/staffApi/share-gift.js`

三份**完全相同**的代码（CloudBase 限制）。未来做 shared-layer 再统一。

```js
// share-gift.js
/**
 * 新客首单分享礼发放
 * @param {pg.PoolClient} client  事务内 client
 * @param {object} order          { saleOrderId, clientUserId, paidAmount }
 * @returns {Promise<{granted:boolean, reason?:string}>}
 */
async function grantShareGift(client, order) {
  // 0. paid_amount 必须 > 0（储值卡全额抵扣场景 paid_amount=0 → 跳过）
  const paid = Number(order.paidAmount)
  if (!order.clientUserId || !(paid > 0)) return { granted: false, reason: 'no_paid_amount' }

  // 1. 读 config
  const cfgRow = (await client.query(
    "SELECT value FROM system_configs WHERE key = 'share_gift_config'"
  )).rows[0]
  if (!cfgRow?.value) return { granted: false, reason: 'no_config' }
  let cfg
  try { cfg = JSON.parse(cfgRow.value) } catch { return { granted: false, reason: 'bad_config' } }
  if (!cfg.enabled || !cfg.couponTemplateId) return { granted: false, reason: 'disabled' }

  // 2. 首单判定
  const isFirstOrder = (await client.query(
    `SELECT COUNT(*)::int AS c FROM sale_orders
      WHERE client_user_id = $1
        AND status IN ('已支付','已完成')
        AND sale_order_id <> $2`,
    [order.clientUserId, order.saleOrderId]
  )).rows[0].c === 0
  if (!isFirstOrder) return { granted: false, reason: 'not_first_order' }

  // 3. 查邀请人
  const inviter = (await client.query(
    `SELECT inviter_user_id FROM client_wechat_users WHERE user_id = $1`,
    [order.clientUserId]
  )).rows[0]?.inviter_user_id
  if (!inviter) return { granted: false, reason: 'no_inviter' }

  // 4. 可选：邀请人资格
  if (cfg.inviterMustHavePaidOrder) {
    const rs = await client.query(
      `SELECT 1 FROM sale_orders
        WHERE client_user_id = $1 AND status IN ('已支付','已完成') LIMIT 1`,
      [inviter]
    )
    if (rs.rows.length === 0) return { granted: false, reason: 'inviter_not_qualified' }
  }

  // 5. 模板必须存在且启用
  const tpl = (await client.query(
    `SELECT template_id, is_active, validity_mode, valid_days, valid_to
       FROM coupon_templates WHERE template_id = $1`,
    [cfg.couponTemplateId]
  )).rows[0]
  if (!tpl || !tpl.is_active) return { granted: false, reason: 'template_unavailable' }

  // 6. 计算面值（分保留 2 位，clamp 到 [min, max]）
  const raw = paid * (cfg.percent || 0.15)
  const rounded = Math.round(raw * 100) / 100
  const value = Math.max(cfg.minFaceValue || 1, Math.min(cfg.maxFaceValue || 500, rounded))

  // 7. expireAt 按模板模式；若模板是 days → 从 NOW 开始推；fixed → 用 valid_to；兜底 90 天
  let expireAt
  if (tpl.validity_mode === 'days' && tpl.valid_days) {
    expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
  } else if (tpl.valid_to) {
    expireAt = new Date(tpl.valid_to)
  } else {
    expireAt = new Date(Date.now() + (cfg.validityDays || 90) * 86400000)
  }

  // 8. 发券 × 2
  for (const [role, userId] of [['inviter', inviter], ['invitee', order.clientUserId]]) {
    await client.query(
      `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, face_value_override, created_at)
       VALUES ($1, $2, $3, '未使用', $4, $5, NOW())
       ON CONFLICT (coupon_id) DO NOTHING`,
      [`sg-${role}-${order.saleOrderId}`, cfg.couponTemplateId, userId, expireAt, value]
    )
  }

  // 9. 消息 × 2（文案模板占位符渲染）
  const vars = {
    paidAmount: paid.toFixed(2),
    couponValue: value.toFixed(2),
    validityDays: Math.ceil((expireAt.getTime() - Date.now()) / 86400000),
  }
  const render = (t) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  for (const [role, userId, title, body] of [
    ['inviter', inviter, cfg.messageInviterTitle, cfg.messageInviterBody],
    ['invitee', order.clientUserId, cfg.messageInviteeTitle, cfg.messageInviteeBody],
  ]) {
    if (!title) continue
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, render(title), render(body), `sg-msg-${role}-${order.saleOrderId}`]
    )
  }

  // 10. operation_logs 一条
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('share.giftGranted', 'sale_order', $1, $2::jsonb, $3, NOW())`,
    [order.saleOrderId, JSON.stringify({
      _v: 1,
      inviter, invitee: order.clientUserId,
      paidAmount: paid, percent: cfg.percent, faceValue: value,
      templateId: cfg.couponTemplateId,
    }), order.source || 'payNotify']
  )

  return { granted: true, value, inviter }
}

module.exports = { grantShareGift }
```

### 5.3 三处支付触点接入

#### payNotify（微信 / 支付宝回调）
在 `UPDATE sale_orders SET status='已支付'` 成功之后、事务 COMMIT 之前：
```js
const { grantShareGift } = require('./share-gift')
// ...
const r = await grantShareGift(pgClient, {
  saleOrderId: targetOrderNo,
  clientUserId: order.client_user_id,
  paidAmount: newPaidAmount,  // 本次回调后 sale_orders.paid_amount 的新值
  source: 'payNotify',
})
if (r.granted) console.log('[payNotify/share-gift]', r)
```
触发条件：UPDATE 后订单 status 为 `'已支付'` 或 `'已完成'`（非 '部分支付'）。

#### staffApi.confirmOffline
同样在 status 终态化后调用：
```js
if (newStatus === '已支付' || newStatus === '已完成') {
  const r = await grantShareGift(pg, {
    saleOrderId, clientUserId: order.client_user_id,
    paidAmount: newPaidAmount, source: 'staffApi',
  })
  if (r.granted) console.log('[staffApi/share-gift]', r)
}
```

#### clientApi.order.create（储值卡全额抵扣路径）
按 §2 决策 #10，`paid_amount = 0` 的路径 grantShareGift 内部会 return；也可以在这里根本不调用。**推荐显式不调用**，减少无谓查询。

### 5.4 coupon 读取时应用 override

`clientApi/routes/coupon.js` 的 `list` 和 `available`：
```sql
SELECT uc.coupon_id,
       COALESCE(uc.face_value_override, ct.discount_value) AS effective_discount_value,
       ct.coupon_type, ct.name, ct.min_spend, ct.max_discount, ...
  FROM user_coupons uc
  JOIN coupon_templates ct ON ct.template_id = uc.template_id
 WHERE ...
```
抵扣计算处也从 `effective_discount_value` 读取而非 `ct.discount_value`。

### 5.5 部署

按 cloudbase-deploy skill，**禁止** `--force`：
```bash
tcb fn code update clientApi
tcb fn code update payNotify
tcb fn code update staffApi --envId <staff-env>
```

部署后验证：
1. `tcb fn invoke clientApi -p '{"action":"auth.bindStore","payload":{"storeId":"...","inviterUserId":"FYGK-..."}}'` 看是否正常 UPDATE
2. 小程序内手工触发首单支付 → 日志含 `[payNotify/share-gift] {granted:true,...}`

---

## 6 admin 配置页

### 6.1 新建页面

`fengyu-admin/src/app/(main)/share-gift/page.tsx`:
```tsx
import { ShareGiftPage } from './_components/share-gift-page'

export default async function Page() {
  return <ShareGiftPage />
}
```

`_components/share-gift-page.tsx`（客户端组件）：
- 开关：`enabled` (Switch)
- 分享礼比例：`percent` (NumberInput, 0.01 ~ 0.50, 默认 0.15)
- 面值上下限：`minFaceValue` / `maxFaceValue`（numeric，默认 1 / 500）
- 券模板选择：下拉（从 `couponTemplates` 拉）
- 有效期天数：`validityDays` (默认 90；若所选模板是 fixed 模式会忽略此项，加说明文案)
- 邀请人资格开关：`inviterMustHavePaidOrder`
- 四条消息文案（2×2 组合 —— 给邀请人 / 给新客 × 标题 / 正文）
  - 支持占位符 `{paidAmount}` / `{couponValue}` / `{validityDays}`
  - 提供预览区（填入 `paidAmount=99.00, couponValue=14.85, validityDays=90` 渲染示例）

### 6.2 Server Actions

`fengyu-admin/src/actions/settings.ts` 新增：
```ts
export async function getShareGiftConfig(): Promise<ShareGiftConfig>
export async function updateShareGiftConfig(input: ShareGiftConfigInput): Promise<void>
```
与 `getBirthdayBenefitsConfig / updateBirthdayBenefitsConfig` 一致的签名风格，Zod 校验入参，返回写入 `system_configs.share_gift_config` 的 JSON 字符串。

### 6.3 导航

`fengyu-admin/src/components/nav/*` 的侧边栏添加一项"分享礼"（或放入"运营"分组）。

---

## 7 实施计划（按 PR 拆分）

### PR-1：Schema 迁移 + Drizzle 变更

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | 修改 schema/user.ts + coupon.ts | `db/schema/user.ts:43`, `db/schema/coupon.ts:68` |
| 1.2 | `npm run db:generate` → 产出 `db/migrations/0007_*.sql` + meta | `db/migrations/` |
| 1.3 | **本地验证**：起临时 PG 空库跑 migrate 一次 | docker drizzle-migrate-test |
| 1.4 | 合并后两库各跑 `db:migrate`（5434 + 5433） | — |

**无代码消费此 schema**，独立可 merge。

### PR-2：admin 配置页 + Server Actions

| # | 任务 | 文件 |
|---|------|------|
| 2.1 | Zod schema for ShareGiftConfig | `fengyu-admin/src/lib/types.ts`（或 actions/settings.ts 本地） |
| 2.2 | `getShareGiftConfig` / `updateShareGiftConfig` Server Actions | `fengyu-admin/src/actions/settings.ts` |
| 2.3 | 新建 `/share-gift/page.tsx` + `share-gift-page.tsx` 组件 | `fengyu-admin/src/app/(main)/share-gift/` |
| 2.4 | 侧边栏 nav 加入口 | `src/components/nav/*` |
| 2.5 | `cd fengyu-admin && npx tsc --noEmit` 过 | — |
| 2.6 | E2E（Playwright）：进入页面 → 填值保存 → reload 后展示一致；预览区渲染正确 | `e2e/share-gift.spec.ts` |

依赖 PR-1 merge（需要 migration 已部署到 5434，否则无害但 config 无消费方）。

### PR-3：小程序分享链路 + bindStore 接 inviter

| # | 任务 | 文件 |
|---|------|------|
| 3.1 | App.onLaunch / onShow 解析 `options.query.inv` | `fengyu-client/miniprogram/app.ts` |
| 3.2 | `globalData.pendingInviter` 类型声明 | `miniprogram/app.d.ts` 或 `typings/global.d.ts` |
| 3.3 | 全量替换 `onShareAppMessage` path 附 `?inv=<userId>` | 首页 / 订单列表 / 订单详情 / 下单结算 / 商品详情 / 顾客个人中心 等 |
| 3.4 | bindStore 页上游传 `inviterUserId`，成功后清空 globalData.pendingInviter | `pages/bind-store/bind-store.ts`（或同等） |
| 3.5 | `clientApi/routes/auth.js` bindStore 接 `inviterUserId`，按 §5.1 UPDATE | `fengyu-client/cloudfunctions/clientApi/routes/auth.js` |
| 3.6 | 部署 clientApi（tcb fn code update） | — |
| 3.7 | 单测：bindStore 不传 inviter 不 UPDATE；传 inviter = 自身 不 UPDATE；首次传入正常 UPDATE；第二次传入不覆盖（WHERE inviter_user_id IS NULL）| `fengyu-client/cloudfunctions/clientApi/__tests__/auth.test.js` |

可与 PR-4 并行（不互相依赖）。

### PR-4：三处支付触点发券 + coupon 读取 override

| # | 任务 | 文件 |
|---|------|------|
| 4.1 | 抽 `grantShareGift()` 通用函数，复制到 3 处 | `payNotify/share-gift.js` / `staffApi/share-gift.js` / （可选） `clientApi/share-gift.js` |
| 4.2 | `payNotify/index.js` 事务内调用 | `fengyu-client/cloudfunctions/payNotify/index.js` |
| 4.3 | `staffApi/routes/order.js` confirmOffline 事务内调用 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` |
| 4.4 | `clientApi/routes/coupon.js` SELECT 加 `COALESCE(face_value_override, discount_value) AS effective_discount_value`；`available` 的抵扣计算用 effective | `fengyu-client/cloudfunctions/clientApi/routes/coupon.js` |
| 4.5 | `clientApi/routes/order.js` 抵扣结算处也用 effective_discount_value | `fengyu-client/cloudfunctions/clientApi/routes/order.js` |
| 4.6 | 部署 payNotify + staffApi + clientApi | — |
| 4.7 | 单测 + 集成测试（见 §8 验收）| 各云函数 `__tests__/` |

**最终 merge 顺序**：PR-1 → PR-2（可与 PR-3 并行） → PR-3 → PR-4。

---

## 8 验收标准

### E2E 场景

1. ✅ **邀请链路 happy path**：老用户 O 登录后分享链接 `path='/pages/home/home?inv=<O.userId>'`；新用户 N 扫码进入 → App.globalData.pendingInviter = O.userId → bindStore 成功后 `client_wechat_users.inviter_user_id = O.userId` 且 `invited_at` 非空

2. ✅ **首单微信支付发券**：N bindStore 后创建订单 paid_amount=100 元，微信支付回调成功 → payNotify 事务内产生：
   - `user_coupons` 2 行：`coupon_id` 分别为 `sg-inviter-{orderId}` / `sg-invitee-{orderId}`，`face_value_override=15.00`，`status='未使用'`
   - `messages` 2 行：`idempotency_key='sg-msg-inviter-{orderId}' / 'sg-msg-invitee-{orderId}'`
   - `operation_logs` 1 行：`action='share.giftGranted'`, `target_id={orderId}`

3. ✅ **幂等**：相同 payNotify 回调重试（或测试中手动第二次 commit 触发）→ 三张表行数均不变

4. ✅ **首单线下支付**：店长走 staffApi.confirmOffline 结清 N 的首单 → 同样产生 2 券 + 2 消息 + 1 日志

5. ✅ **储值卡全额抵扣跳过**：N 用储值卡抵扣 200 元套餐，sale_orders.paid_amount=0 / prepaid_card_amount=200 → 不产生任何分享礼记录；operation_logs 无 `share.giftGranted`

6. ✅ **非首单不触发**：N 已有一笔历史结清订单，新下第二单 200 元结清 → 不产生分享礼记录

7. ✅ **无邀请人不触发**：N 未绑定 inviter_user_id 直接首单 → 不产生分享礼记录

8. ✅ **邀请人=自身防护**：构造 `inviter_user_id = user_id` 写入尝试 → DB CHECK 拒绝 + 业务层拒绝（双保险）

9. ✅ **面值 clamp**：首单 paid_amount=2.00（×15%=0.30），配置 minFaceValue=1 → face_value_override=1.00；首单 paid_amount=10000.00（×15%=1500），maxFaceValue=500 → face_value_override=500.00

10. ✅ **部分支付等到结清才触发**：首单 300 元，首付 100（status='部分支付'）→ 不触发；再回款 200（status='已支付'）→ 触发，face_value_override 按 paid_amount=300 × 15% = 45.00

11. ✅ **config.enabled=false 跳过**：admin 关掉开关 → grantShareGift 返回 `{granted:false, reason:'disabled'}`，无任何记录产出

12. ✅ **coupon.list 展示 override 优先**：发完券后 N 调用 `coupon.list`，返回的 `effective_discount_value=15.00`（而非模板里 0 或占位值）；抵扣结算订单时生效

### 单元测试覆盖

- `grantShareGift` 12 种 reason 路径：`no_paid_amount` / `no_config` / `bad_config` / `disabled` / `not_first_order` / `no_inviter` / `inviter_not_qualified` / `template_unavailable` / `granted` / 重试幂等 / clamp 上下限 / 部分支付不触发

- `bindStore` inviter 写入：4 种场景（不传 / 传自身 / 首次传 / 重复传）

- admin Server Actions：`getShareGiftConfig` 缺省值、`updateShareGiftConfig` Zod 校验、比例边界（0.01 ~ 0.50）

---

## 9 风险与决策点

| # | 风险/决策 | 处理方案 |
|---|---|---|
| 9.1 | 小程序分享链接被爬虫 / 机器人访问，`inv` 参数被假冒注入 | bindStore 端 EXISTS 子查询兜底；即便 inviter 不存在 UPDATE 0 行无害；`inv` 参数格式 `FYGK-{YYYYMMDD}{序号}`，前端再加正则校验 |
| 9.2 | 用户自己多号自刷：A 账号分享给 A 新开的 B 号 | 同手机号（同 phone）会被 `uq_client_users_phone` 部分唯一索引 UPSERT 合并行（auth.js 现有逻辑），A ≠ B 只能同时存在两个独立 phone；且默认 `inviterMustHavePaidOrder=false`，若运营发现薅羊毛迹象打开此开关即可硬性拦截 |
| 9.3 | 客户端 `path='/pages/home/home?inv=...'` 在小程序 scheme 码分享时可能被微信清理；`scene` 参数比较稳妥 | 本 ticket 使用 query 参数，足够覆盖好友分享场景；小程序码分享（场景码）另开 ticket（需生成 API + scene 解码） |
| 9.4 | `grantShareGift` 失败不能阻塞主支付事务 | 函数设计为**幂等返回布尔**，主流程用 try / catch 包裹，失败仅 console.error，不 rollback 支付事务 |
| 9.5 | 同一 orderId 的分享礼发放延迟到下一次 cron 重扫 | 本 ticket **不依赖 cron 兜底**；若因 payNotify / confirmOffline 同步调用失败未发，运营需人工补。未来可补一个 cron 扫"近 7 天内已支付订单中符合条件但无对应 operation_logs 的订单"做补发，不在本 ticket |
| 9.6 | PR-3 替换 onShareAppMessage 的地方可能遗漏 | PR-3 验收步骤：在 miniprogram 目录 `grep -rn "onShareAppMessage"`，列出所有命中点，逐一审查；PR 描述里列清单 |
| 9.7 | user_coupons.face_value_override 为 NULL 的历史券读取一致性 | `COALESCE(uc.face_value_override, ct.discount_value)` 对 NULL 回退到模板值，完全向下兼容，历史券零影响 |
| 9.8 | 分享礼券的 min_spend / applicable_product_ids 等限制 | **完全由 couponTemplates 控制**；运营可以给"分享礼专用模板"设置 min_spend=50 或限定品类，避免 15 元券用在 10 元体验卡上 |
| 9.9 | 新客首单退款 → 已发分享礼券 | §2 决策 #13：MVP 不回收。运营通过 admin 查 operation_logs 手动作废；后续单独 ticket 自动化 |
| 9.10 | 新客首单但新客自己也是老客户的微信同步行（有 customer_id 但无 openid，后来绑定同一 phone 合并）| 合并后 user_id 不变（uq_client_users_phone 保留原行），首单判定看 `client_user_id + status` 仍准确；`inviter_user_id` 一次写死防止事后补绑 |
| 9.11 | 配置中 couponTemplateId 指向的模板被运营删除 / 停用 | grantShareGift 的 §5.2 第 5 步 `is_active` 校验会拒绝发放，返回 `template_unavailable`；admin 配置页最好提供"模板状态"预警 |
| 9.12 | 分享链接在老用户未登录时也能生成 | 未登录 `userId` 为空 → path 不带 inv → 被分享人登录后 pendingInviter 为空 → 不绑定邀请关系；链路自然降级 |
| 9.13 | 多次回款路径下，哪一次结清的 paid_amount 用作基数 | §2 决策 #11 + §5.2 第 6 步：以 status 进入 '已支付' 瞬间 `sale_orders.paid_amount` 的值（即累计已支付总额）作为基数；和原文"首单 paid_amount"语义完全匹配 |
| 9.14 | TypeScript / Zod 上新字段类型定义漏改 | PR-1 之后跑 `cd fengyu-admin && npx tsc --noEmit`；PR-2 之后再跑一次，确保 lib/types.ts 到页面组件类型传递正确 |
| 9.15 | 小程序 onShareAppMessage 在 devtools 模拟分享时可能 userId 未加载完 | 兜底：`if (!userId) return { title, path: '/pages/home/home' }`（不带 inv）；PR-3 验收在真机测试 |

---

## 10 不在本 ticket 范围

- **退款回收分享礼券**：新客首单退款后已发券的生命周期处理（作废 / 报警 / 扣减老客户已用券的信用），另开 ops ticket
- **多级邀请 / 裂变链**：A 邀请 B，B 邀请 C 时 A 是否有分润，合规风险高，不做
- **员工邀请客户**：`promoter_employee_id` 已覆盖，独立业务
- **小程序码（带 scene）分享**：需生成小程序码 API + scene 解码逻辑，另开 ticket
- **订阅消息 / 模板消息推送**：`messages` 表只写站内，微信订阅消息推送链路独立
- **邀请榜单 / 我的邀请记录页**：纯展示需求，基于 `inviter_user_id + invited_at + operation_logs` 可查；admin 或 client 端 UI 另开
- **月度 / 年度邀请上限**：防刷扩展，配置项留位 `maxInvitesPerMonth` 字段预留但 MVP 不消费
- **邀请人/新客不同的券模板**：目前只有一个 `couponTemplateId`，未来可扩为 `inviterCouponTemplateId` / `inviteeCouponTemplateId`
- **分享礼与会员权益叠加互斥**：生日当天首单是否叠发？本 ticket **叠加发放**（两者独立幂等键），若运营反馈需要互斥再扩展
- **storeId 维度差异化分享礼比例**：不同门店不同比例，admin UI 不支持，不做
- **cron 兜底补发**：payNotify / confirmOffline 同步失败时的补发 cron，另开 ticket
- **分享链路安全签名**：`inv` 参数防篡改 / 签名校验（当前靠 EXISTS + 一次性写死兜底），另开 ticket
- **admin 侧运营分析看板**（分享礼 GMV / 转化率）：纯 BI，另开 ticket

---

## 11 相关引用

### 现有代码
- 顾客表：`db/schema/user.ts:12-79`（含 `promoterEmployeeId` 现有字段参考）
- 优惠券：`db/schema/coupon.ts:11-75`
- 订单：`db/schema/order.ts:40-117`（`clientUserId` / `status` / `paidAmount` / `paidAt`）
- 订单款项：`db/schema/order.ts:239-285`（`saleOrderPayments.changeType` 订单内语义）
- 消息幂等：`db/migrations/0006_wonderful_earthquake.sql`（`idempotency_key` 已落地）
- 操作日志：`db/schema/operation-log.ts`
- 系统配置：`db/schema/system-config.ts`
- clientApi bindStore 现有 source 参数：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:203,241-248`
- payNotify 支付回调：`fengyu-client/cloudfunctions/payNotify/index.js:149-273`
- staffApi confirmOffline：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:750-900`
- clientApi order.create 储值卡路径：`fengyu-client/cloudfunctions/clientApi/routes/order.js:460-520`
- cronTask grantUpgradeBenefits（发券 / 消息 / 积分的参考实现）：`fengyu-client/cloudfunctions/cronTask/index.js:160-260`
- admin member-benefits 现有页（作为 "配置页的反面参考——本 ticket 另建新页"）：`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx`
- admin settings Server Actions 参考：`fengyu-admin/src/actions/settings.ts:70-346`

### 关联 ticket
- 本 ticket：`notes/tickets/2026-04-24-share-gift-reward.md`
- 并行（无强依赖）：
  - `notes/tickets/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`
  - `notes/tickets/2026-04-24-member-birthday-benefits.md`
  - `notes/tickets/2026-04-24-member-thanksgiving-benefits.md`
  - `notes/tickets/2026-04-24-multi-repayment-three-ends.md`
  - `notes/tickets/2026-04-24-refund-admin-parity-and-rules.md`

### 规范与记忆
- `.42cog/cog.md` — 顾客 / 订单 / 券认知模型
- `.42cog/real.md` — 幂等硬规则
- `.42cog/pm/client.pr.spec.md` — 客户端产品规范（分享链路）
- `.42cog/pm/admin.pr.spec.md` — 管理后台产品规范（运营配置页）
- `db/CLAUDE.md` — schema 变更工作流（两库迁移、generate / migrate 流程）
- `project_cloudbase_envvar_risk.md` — `tcb fn deploy --force` 禁用
- `project_db_dual_env.md` — 5433/5434 双库
