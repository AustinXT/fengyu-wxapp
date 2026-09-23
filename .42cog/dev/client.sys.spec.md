# 凤御顾客端小程序 — 系统架构规格书

> 仅记录代码中无法推断的架构决策和约束机制。目录结构、API 列表、DB schema 请直接读取代码。
> **依赖文档**: `real.md` v3.1.0 | `cog.md` v4.0.0 | `client.pr.spec.md` v2.0.0 | `backend.pr.spec.md` v4.0.0

## 1. 架构拓扑

```text
┌─────────────────────────────────────────────┐
│     fengyu-client 顾客端小程序               │
│     appid: wx811eb4ded3dfba3f               │
│                                             │
│  ┌─ 主包 ─────────────────────────────────┐ │
│  │ home / appointment / cart / profile     │ │
│  └────────────────────────────────────────┘ │
│  ┌─ 分包 ─────────────────────────────────┐ │
│  │ pagesShop / pagesOrder / pagesStore /  │ │
│  │ pagesAppointment                       │ │
│  └────────────────────────────────────────┘ │
│           │                                 │
│     wx.cloud.callFunction                   │
│           │                                 │
└───────────┼─────────────────────────────────┘
            ▼
┌─ CloudBase 环境 A ──────────────────────────┐
│  cloud1-3gpht4b01ff88838                    │
│  ┌──────────┐  ┌──────────┐                 │
│  │ clientApi │  │payNotify │                 │
│  │ (网关)    │  │(支付回调) │                 │
│  └────┬─────┘  └────┬─────┘                 │
└───────┼──────────────┼──────────────────────┘
        │              │
        └──────┬───────┘
               ▼
      PostgreSQL（自托管，共享）
```

**关键隔离**：
- 顾客端与员工端使用**独立 CloudBase 环境**，云函数互不可见
- 两端 OPENID 相互独立（不同 appid），`client_wechat_users` 与 `staff_wechat_users` 完全分离
- 唯一共享资源：PG 数据库

## 2. 架构决策

| 决策 | 理由 |
|------|------|
| 单函数多路由（clientApi action 网关） | 减少冷启动次数，CloudBase 免费额度按函数数计费；payNotify 例外（微信回调 URL 固定） |
| 云函数用原生 SQL（`pg` 库） | CloudBase 运行时不支持 TS，引入 Drizzle 增加包体积和冷启动时间 |
| 购物车存 localStorage 而非服务端 | 顾客端无需跨设备同步；减少网络请求；切换门店时整体清空 |
| 分包策略按业务域划分 | pagesShop（商品）/ pagesOrder（订单）/ pagesStore（门店）/ pagesAppointment（预约），主包 < 2MB |
| 认证零登录页 | 微信静默登录 + CloudID 手机号解密；`PHONE_REQUIRED` 错误码触发绑定流；禁止自建登录表单 |
| 扫码支付复用已有订单 | 员工端开单时订单已入库（`待支付`），顾客扫码后无需重复创建，仅查询并支付 |
| 商品分页 + 模块级缓存 | SPU 列表按分类缓存（`categoryId` 为键），scroll-to-lower 500ms 防抖避免重复请求 |
| 福利活动绕过购物车 | 福利活动单品直接下单，不进购物车，确保单独成单（`sale_order_type='福利活动'`） |

## 3. 认证模型

```text
app.onLaunch()
  → localStorage 恢复 → auth.login（静默，OPENID 自动注入）
  → 新用户：自动创建 client_wechat_users（ID: FYGK-{YYYYMMDD}{序号}）
  → 需手机号时：API 返回 -403 PHONE_REQUIRED
    → 前端 getPhoneNumber（CloudID）→ auth.bindPhone
    → 触发历史订单补全（client_user_id IS NULL + phone 匹配）
    → 清除 auth 缓存 → 自动重试原请求
```

**顾客端认证无角色区分**，所有已认证用户权限等同。数据隔离通过 `WHERE client_user_id = 当前用户` 实现。

**手机号补全机制**：员工以手机号开单 → 顾客后续注册绑定手机号 → `sale_orders.client_user_id` 批量回填，历史订单自动可见。

## 4. 前端状态管理

| 状态类型 | 存储位置 | 说明 |
|---------|---------|------|
| 认证信息 | `app.globalData` + localStorage | `onLaunch` 先 restore 再 sync |
| 购物车 | localStorage（`utils/cart.ts`） | CartItem: `{ skuId, spuId, spuName, skuDisplayName, coverImage, price, quantity, bigCategory, productType, addedAt }` |
| 结算数据 | localStorage `checkoutItems` | 购物车结算时写入，结算页读取 |
| 商品缓存 | Page 级内存 | 按 categoryId 缓存 SPU 列表，切换门店时清空 |
| 门店绑定 | `app.globalData.boundStoreId` + localStorage | 首次选择后默认展示该门店商品 |

**无全局状态管理库**：小程序原生模式，页面间通过 URL 参数 + localStorage + `globalData` 通信。

## 5. 云函数中间件链

```text
clientApi 请求处理流程：

event { action, payload }
  → index.js: 解析 action → require(`./routes/${module}`)
  → middleware/auth.js: OPENID → 查 client_wechat_users → ctx.auth
    （auth.login / order.scanDetail 跳过认证）
  → middleware/validate.js: 参数校验
  → routes/[module].[method](payload, ctx)
  → 响应: { code: 0, message, data } 或 { code: -1/-400/-403, message }
```

**免认证接口**：`auth.login`（创建用户本身）、`order.scanDetail`（扫码查单，支持未注册用户）。

**错误码体系**（9 项官方白名单，单源：`cloudfunctions/clientApi/utils/error-codes.js`）：
- `0` — 成功
- `-1` — 通用错误（非白名单前缀降级）
- `-400` — 参数错误 / 状态机阻塞 / 余额不足 / 顾客未注册（前缀 `INVALID_PARAMS:` / `INVALID_STATE:` / `INSUFFICIENT_BALANCE:` / `CLIENT_NOT_REGISTERED:`，**按 `errorType` 区分**）
- `-401` — 未认证（`UNAUTHORIZED:` 前缀）
- `-403` — 手机号未绑定 / 权限不足（`PHONE_REQUIRED:` 或 `PERMISSION_DENIED:`，**按 `errorType` 区分**）
- `-404` — 资源不存在（`NOT_FOUND:` 前缀）
- `-409` — 并发冲突（`CONFLICT:` 前缀）

跨端一致性由 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` snapshot 守护。

## 6. 约束保障机制

| real.md 约束 | 顾客端实现 |
|-------------|-----------|
| 次数防超卖 | 顾客端不直接扣次数；仅通过 `service.detail` 查看剩余次数 |
| 价格快照不可变 | `order.create` 时从 `product_skus.price` 快照到 `sale_items.unit_price`，前端显示的价格与下单时独立 |
| 支付幂等 | `order.pay` / `payNotify` 通过 `WHERE status='待支付'` 幂等；线下确认由员工端操作 |
| 状态单向推进 | 顾客端仅可：取消订单（待支付→已关闭）、取消预约（待确认/已确认→已取消）；其他状态变更由员工端或系统触发 |
| 待支付订单唯一 | `order.create` 时 PG 部分唯一索引 + 应用层 pre-check；前端防连点 + 按钮 loading 态 |
| 组织域数据隔离 | 所有查询 `WHERE client_user_id = ctx.auth.userId`，顾客只能看到自己的订单/预约/服务单 |

## 7. 跨模块业务流

### 7.1 自助下单支付

```text
product.shopInit(门店商品初始化)
  → product.categories / product.spuList / product.skuDetail
  → 加入购物车(localStorage) 或 直接下单
  → order.create(SKU 快照 + 可选美容师 + 可选券 + useCard/prepaidCardAmount)
    → 事务内 SELECT balance FROM prepaid_cards WHERE user_id FOR UPDATE
    → 写入 sale_orders(pending_prepaid_card_amount + payable_amount)；扣卡后才累计 prepaid_card_amount
    → payment_method 规则:
        paid_amount = 0  → 强制落 '无'（同事务扣卡 + 置已支付，跳过 order.pay）
        paid_amount > 0  → 取前端传值 ∈ {'微信','支付宝','线下'}
    → 返回 orderNo
  → order.pay(wechat/alipay/offline)
    → 金额 = paid_amount（不是 total_amount）；= 0 直接短路
    → wechat: 调起微信支付 → payNotify 回调 → 同事务扣卡 + 更新已支付
    → offline: 更新待确认收款 → 等待店长 confirmOffline 时扣卡
  → 已支付 + 指定美容师 → 自动创建 sale_allocations
```

### 7.2 扫码支付（跨双端，含预选抵扣调整）

```text
员工端 order.create → PG 订单(待支付, 预选 pending_prepaid_card_amount；balance 未动)
  → 员工端 order.qrcode → 生成小程序码(含 orderNo 或 path)
  → 顾客微信扫码 → 顾客端解析:
    → path 型: navigateTo 对应页面
    → orderNo 型: 跳转 scan-pay 页面
  → order.scanDetail(免认证, 仅员工开单订单)
    + card.balance(拉取实时余额，用于调整)
  → 顾客可调整预选方案:
    → order.scanAdjust(useCard, prepaidCardAmount?, paymentMethod?)
      → 后端重算 pending_prepaid_card_amount / payable_amount / payment_method
      → status 保持'待支付'，balance 仍不动
  → 顾客点"确认支付":
    → paid_amount = 0 → order.confirmPrepaidFull
        事务内 SELECT FOR UPDATE + 扣卡 + INSERT card_transactions(扣款) + 置已支付
    → paid_amount > 0 + 微信 → order.pay → payNotify(同 7.1 扣卡)
    → paid_amount > 0 + 线下 → order.offlinePay → 待员工 confirmOffline 扣卡
```

### 7.3 预约核销

```text
订单已支付 → order.appointableItems(remaining_sessions > 0, 非家居产品)
  → appointment.create(选项目/美容师/时段)
    → ID 格式: apt_{timestamp}_{random}
    → 时段: 09-11/11-13/13-15/15-17/17-19
  → 员工端 appointment.confirm → 员工端 service.create(关联 appointment_id)
  → 服务完成(员工端) → 原子扣减 remaining_sessions
  → 归零 → 自动关闭关联预约
```

### 7.4 门店解绑

```text
顾客发起 store.requestUnbind(reason)
  → status: 待处理
  → 员工端 store.approveUnbind / rejectUnbind
  → 已通过: 清除 client_wechat_users.bound_store_id
  → 顾客可查看状态 / 可取消(待处理 时)
```

## 8. 外部集成

| 外部系统 | 集成方式 | 触发点 |
|---------|---------|--------|
| 微信支付 | payNotify 云函数接收回调 | `order.pay` 调起支付后 |
| 微信身份 | `cloud.getWXContext()` 零代码注入 | 每次云函数调用 |
| CloudID 手机号 | `getPhoneNumber` → 云端解密 | `auth.bindPhone` |
| 腾讯地图 | `store.geocode` 逆地理编码 | 门店列表页定位推荐 |
| CloudBase 云存储 | 商品封面图/门店环境图 URL | 前端 image 组件直接引用 |

**环境变量**：
- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `TMAP_KEY` / `TMAP_SECRET` — 腾讯地图 API

## 9. 订单超时机制

**10 分钟超时**：`expire_at = sale_order_datetime + 10min`，不存储字段，应用层 SQL 条件懒清理。

清理入口（改守卫或释放逻辑时必须逐个扫）：

| 入口 | 形态 | 说明 |
|---|---|---|
| `order.create` / `order.list` | 批量，走 `closeExpiredOrdersByUser` | 候选 SELECT **刻意是超集**（只带 status + opened_by + 时间，⚠️ **不要加 `lakala_out_order_no IS NULL`**，见下），真正裁决在 `closeExpiredOrder` 的 UPDATE |
| `order.pay` / `order.alipayPay` / `order.offlinePay` | 单笔，关成了就抛「订单已超时」 | 支付入口的拒绝守卫 |
| `order.detail` | 单笔，关单 + **有界重试两次** | issue #215 新增：请求处理期间可能跨过截止点 |
| `card.recharge` | 单笔批量，`_closeExpiredPendingByUser` | **独立实现**，守卫是超集（多一条 `sale_order_type <> '转换单'`），释放侧只回滚优惠券 |

⚠️ **order 侧**的候选 SELECT（`closeExpiredOrdersByUser` 与 `closeExpiredOrder` 自身的 `SELECT ... FOR UPDATE`）都是**超集、fail-safe** 形态：选多了只是白跑空事务，不会错关（裁决全在 UPDATE 的 CAS 上）。同源锁只锁 UPDATE 侧与判据常量，不锁这两个 SELECT。

**别往候选 SELECT 里加 `lakala_out_order_no IS NULL`**（issue #215 round-7 加过、round-8 撤回）：看起来能省掉几个空事务，实际会漏单 —— 该列双向可变，SELECT 之后、CAS 之前它可能被 payNotify / 对账 / 支付失败清理清成 NULL，那一刻这单已经该关了，而收窄过的候选集根本没把它选进来。后果是过期单继续占着 `uq_sale_orders_client_pending`，顾客再下自助单被唯一约束拒绝。**选多了是浪费，选漏了是功能错误。**

✅ **`card.js` 的候选 SELECT 已与 order 侧同为超集口径**（issue #215 一并改掉）：它此前带着 `lakala_out_order_no IS NULL`，有同型的漏关面。⚠️ 但 `card.test.js` 的守卫锁**只锁 UPDATE 侧**，测不到这个 SELECT —— 别再往里加回条件。

**懒清理的三条守卫**（`closeExpiredOrder`，缺一不关）：

| # | 守卫 | 原因 |
|---|---|---|
| 1 | `status = '待支付'` | 状态机 |
| 2 | `opened_by IS NULL` | 员工/店长开单交顾客扫码，扫码时刻往往已超 10 分钟，不能被自助懒清理误关（issue #27） |
| 3 | `lakala_out_order_no IS NULL` | 有在途支付意图时不能关单，否则渠道侧仍可支付 |

另有**第二条**会把待支付单置「已关闭」的路径：`card.js` 的 `_closeExpiredPendingByUser`（顾客充值时触发），守卫是上面三条**再加**一条 `sale_order_type <> '转换单'`——条件严格强化，**命中集合是真子集**，方向安全，不会关掉判据认为关不掉的单。由 **`card.test.js`** 的规范化条件列表**全等**断言钉住（锁连接符、条件集合与数量；规范化 helper 在 `__tests__/helpers.js`，与 order 侧共用 —— 锁必须待在改守卫的人会跑的那个文件里）。

⚠️ **「同源」仅限守卫侧，不含释放侧**：`closeExpiredOrder` 关单时会回滚优惠券、调 `releasePointsDeduction` 退还积分、把 `pending_prepaid_card_amount` 归零、重算 `payable_amount`；`card.js` 那条**只回滚优惠券**（且回滚现已正确地跟着 CAS 走）。两处缺口都是早于 issue #215 的既有缺陷，已单列跟进项：

1. **积分不退**：顾客用积分抵扣下单 → 弃付 → T+10 后直接进充值（没经过 order.detail/list/pay，懒清理没跑过）→ 单子被充值路径关掉，「消费抵扣」永远等不来「消费抵扣退回」，积分凭空蒸发。
2. **待结算储值卡不归零、应付额不重算**：已关闭订单行残留旧的 `pending_prepaid_card_amount` / `payable_amount`，与 `closeExpiredOrder` 关出的行口径不一致。余额本身未动（待结算只是计划额，实扣在 pay / confirmPrepaidFull），非直接资金损失，但影响读取与报表。

⚠️ **线下付款的自助单也在懒清理的命中集合里**（`closeExpiredOrder` 没有 `payment_method` 守卫），
但订单详情的状态区被「请到店付款，等待店长确认收款」占住，顾客看不到任何时限，T+10 单子照关。
这是早于 issue #215 的既有行为，口径待甲方拍板（见 issue #215 评论），当前实现未改。

**`expire_at` 的下发口径与这三条守卫同源**（issue #215）：判据写成 SQL 常量 `PENDING_AUTO_CLOSE_GUARD_SQL`，由 `order.detail` 的主查询算成 `auto_close_eligible` 列，**交给 PostgreSQL 求值**，只对「这一刻的懒清理真会关掉它」的订单下发 `expire_at`。

**不在 JS 里镜像这个谓词**：镜像就要逐个处理 `IS NULL` vs `== null`、空串（SQL 里不是 NULL）、列没被 SELECT 出来是 `undefined`——全是跨语言复制凭空带来的自伤。代价是 L1 的 pg mock 测不到谓词语义，由 L2 真值表补上：`fengyu-client/tests/e2e-cloudfn/order/auto-close-guard-truthtable.spec.mjs`（**零写入**，纯 `VALUES` 构造行，判据从 `routes/order.js` 原样读取，10 例覆盖空串 / 纯空白 / 各状态）。

`auto_close_eligible` 是服务端中间量，**不下发给前端**（下发出去会诱使前端拿它自己推导展示口径）。**可支付态（待支付 / 部分支付）必须重读该列**——主查询是懒清理**之前**的快照，而 `lakala_out_order_no` 双向可变，另一台设备的 `order.pay` 随时会写进来；只在「跑过懒清理」时重读的话，未超时的单照样会发出「有倒计时 + `has_active_payment_intent=false`」这种分叉。重读挂在既有的 `Promise.all` 批次里，不额外增加往返。

改 `closeExpiredOrder` 的 UPDATE 守卫必须同步改这个常量，由 `order.test.js` 钉住——断言是**规范化后的条件列表全等比较**（锁住连接符、条件集合与数量），不是子串包含：后者对 `AND → OR`、单侧多加一条守卫都判不出来。

⚠️ **`closeExpiredOrder` 不带 `sale_order_type <> '转换单'` 是有外部前提的**：同文件另外两条「置已关闭」（`card.js` 的充值路径、`order.cancel`）都带这条排除，唯独它不带，靠的是「转换单恒有 `opened_by`」这条**定义域前提**——顾客端 `order.create` 硬编码 `'销售单'`、`card.recharge` 硬编码 `'充值单'`，转换单只由 staff/admin 落单且必写 `opened_by`。前提一旦破（比如放开自助转换单、或新落单路径漏写 `opened_by`），转换单就会被这里关掉，而它的释放侧**不执行** `rollbackPendingConversionOnClose`——疗程卡次数 / 家居数量会永久蒸发。由 `order.test.js` 的字面断言钉住顾客端两处 `INSERT INTO sale_orders` 的单据类型。

⚠️ **`closeExpiredOrder` 体内不得有任何时间谓词**：「过没过 10 分钟」一律由调用方判。`order.detail` 的「补关到关不动为止、否则就不下发权威值」契约架在这条前提上（见下文）；这里一旦加上 `sale_order_datetime < NOW() - INTERVAL '10 minutes'` 之类的「加固」，补关成败就取决于 PG 与云函数宿主的时钟差 —— PG 慢一点就关不掉而复读仍判 eligible，矛盾态从后门回来。同源锁里有对应断言。

⚠️ **`order.scanDetail` 永不下发 `expire_at`**：它的主查询自带 `WHERE opened_by IS NOT NULL`（只服务员工开单订单），字段是显式映射、不含任何 expire 字段；`scan-pay` 页也没有任何时效文案。issue #215 验收标准 4「扫码支付页同步对齐」因此**天然成立**（2026-09-22 全页 grep 核实）。⚠️ 将来若让 scanDetail 也服务自助单或补下发时限，**必须走 `PENDING_AUTO_CLOSE_GUARD_SQL`**——否则口径分叉会从这一端复发，而那里目前没有任何同源锁。

⚠️ **数据不变量**：`lakala_out_order_no` 只有两种合法形态 —— `NULL`（无意图）或**非空白字符串**（活动意图）。空白非 NULL 是非法态：SQL 守卫按 `IS NULL` 判「有意图、关不掉」，而 #214 的 `has_active_payment_intent` 按 `trim()` 判「没有意图」，两者会错开。目前无任何写入路径能产出它（写入点只有 `= NULL` 与生成的 `${saleOrderId}_${ts}`），2026-09-22 在 dev 库实测 31859 张单中该形态为 **0** 条。

前端倒计时：待支付详情页 `MM:SS` 格式，1s 刷新。未下发 `expire_at` 时不起倒计时，文案退为「请完成支付」。

**「归零重载」按拿到的剩余量分情况**（否则 `loadDetail → startCountdown → 归零 → loadDetail` 就是按网络 RTT 空转的死循环）：

| 拿到的剩余量 | 行为 | 有界性来自 |
|---|---|---|
| 权威正数（`expire_in_ms > 0`），扣 RTT 后仍为正 | 正常计时 | — |
| 权威正数，扣下行后归零 | 清 UI + **只改文案** + 有界重试 | 服务端侧补关：重载回来要么已关闭、要么降级成非权威 |
| 走着走着归零（tick） | 清 UI + **只改文案** + 有界重试 | 同上 |
| 隐藏期间跨过截止点 | 清 UI + **只改文案**（不在此处发请求，紧随的 onShow 会走有界重试刷新） | 同上；且隐藏期**分不清**「真过了 10 分钟」和「用户把钟拨快了」 |
| 非权威归零（旧云函数只给 `expire_at`） | 清 UI + 重载，**按订单号只一次** | `_fallbackZeroReloadedOrderId` |
| 墙钟跳变（任一方向） | 清 UI + 校准，**不改文案也不封** | 一拍最多排 1 秒，观测间隔离谱（回拨 > 2s / 前跳 > 30s）就是时钟不可信，**不**等于截止点已过。往回跳会凭空延长倒计时，往前跳会把服务端还认可的单判成过期 —— 两个方向都得当作「需要校准」而非「已过期」 |
| 服务端说「已过期但没关掉」（`expire_unresolved`） | 清 UI + **封支付入口** + **按退避续排刷新** | 页面写着「正在确认订单状态」，没人去确认这句话就是假的；挡路的支付意图是瞬态的，隔几秒服务端多半能关掉 |

**设备只负责量相对流逝，绝对判断与绝对时刻都由服务端给**（issue #215）：

| 字段 | 用途 | 为什么不能前端自己推 |
|---|---|---|
| `expire_in_ms` | 倒计时基准（剩余毫秒） | 拿设备时钟比 `expire_at`，手机快几分钟就会把刚下发的时限判成「已过期」，自助单彻底看不到倒计时 |
| `expire_clock` | 「请在 HH:mm 前完成支付」的时刻 | `getHours()` 取的是**设备时区**，顾客出境后同一行会变成「请在 03:15 前完成支付（剩余 09:30）」 |

旧云函数不带这两个字段时前端回退到绝对时间口径（发版过渡期，比没有倒计时好）。⚠️ **回退口径的归零必须按订单号只放行一次重载**：旧后端对员工单、有在途意图的自助单永远关不掉却照发已过期的 `expire_at`，不设闸门就是「每个 RTT 一次 `order.detail`」的无界循环 —— 正是本 issue 要消灭的东西躲进了过渡路径。权威口径不需要这个闸门（收敛由服务端补关保证）。

倒计时用 `setTimeout` 链而不是固定 1000ms 的 `setInterval`：每次按「显示值该变的时刻」调度，最后一拍恰好落在截止点。固定间隔会让截止后最多 999ms 里还显示着「剩余 00:01」，而订单已过期、点「去支付」直接被拒。

**协议：权威值恒为严格正数。** 服务端只在剩余量 > 0 时才下发 `expire_in_ms`，下发即意味着「这一刻订单确实还开着、而且到点会被关掉」。走到「可关且已过期」还没关成（补关**有界重试两次**后仍被并发写入的支付意图挤掉）就**不下发**，让前端退到非权威口径。

前端拿到 `<= 0` 一律视为协议降级（旧版本云函数、或上述服务端降级），走**带一次性闸门**的重载路径 —— 绝不当成「服务端已经处理完了」而永不重载。有界性因此不依赖协议版本：非权威归零每单最多重载一次；权威路径的收敛由服务端补关保证（重载回来要么已关闭、要么降级成非权威再吃一次闸门）。

⚠️ 别把「最多两次」写成保证 —— 那只描述**单次 `order.detail` 内服务端最多补关两次**。前端侧的 `expire_unresolved` 是**按退避持续续排**的（5→10→20→40→60 秒封顶），直到拿到一份「已解决」的响应为止；按「最多两次」截断的话，页面会永久停在「正在确认订单状态」。

**文案与支付封禁必须分开**（issue #215，第 16 轮回退）：

| 标志 | 来源 | 作用 |
|---|---|---|
| `expiryPendingConfirm` | **本地**判到期（上表前三行） | 只把状态区文案改成「支付时限已到，正在确认订单状态」；**不封**支付入口 |
| `payBlockedByExpiry` | **服务端**明说 `expire_unresolved` | 同样的文案 **+ 封掉支付入口**（那时 `order.pay` 必拒 —— 预检关单后抛超时；即便预检 CAS 输给并发意图，`reserveDirectOnlinePaymentIntent` 的行锁内还有一道十分钟守卫） |

第 9 轮起这两件事曾绑在一起，结果此后每一轮都在补一条新的时钟异常路径（RTT 扣光 / 隐藏期跨点 / 墙钟回拨 / 墙钟前跳 / 上下行不对称……）—— 因为任何一次**本地**误判都会封掉一张还能付的单。失败模式极不对称：**误封 = 收不到钱且顾客无从下手；误放 = 一条「订单已超时」提示，可恢复**。而且订单列表页的「去支付」本来就绕过详情页直达结算，这道闸从来不严丝合缝。所以判据回归后端。

倒计时归零后**不能退回裸的「请完成支付」**（那是在承诺不知真假的事）：改文案 + 有界重试（5s→10s→…→60s 封顶，成功即复位；`onHide`/`onUnload` 清掉）。**刷新型加载不置 `isLoading`** —— wxml 的 `wx:if="{{!isLoading}}"` 会把整个 container 摘掉，`expire_unresolved` 那条会一直轮询，置它就让整页每圈闪一次。

`loadDetail` 走 **single-flight**：同一时刻最多一个在途请求，期间再来的合并成一次尾随刷新，所有调用方都能 await 到最终完成。用单调 token「后发起者获胜」是不够的 —— 那保证的是**发起顺序**赢而非**数据新旧**赢，先发起的请求完全可能后到服务端、读到更新的快照却被判废，一张刚支付成功的单就会被画回「待支付」。

时延扣减取**网络残差的一半**而非整段：整段会把上行也算进去，弱网上行慢时页面会比真实截止提前归零 —— 后果是**提前切进「正在确认订单状态」并多打一轮刷新**（不封支付入口，封禁只认服务端的 `expire_unresolved`），弱网下会反复触发重试。

`loadDetail` **必须如实返回成败**：调用方据此决定要不要重试。它一度把失败吞掉只返回 void，结果就是「墙钟回拨后校准成功也白打一发」和「支付确认轮询收尾那次刷新失败无人兜底」两个缺陷。所有「这次刷新必须成功、否则页面会停在不可信状态」的场景共用一个**按结果续排**的有界重试（5s→10s→…→60s 封顶，`onHide`/`onUnload` 清掉，**只在拿到「已解决」响应时复位退避** —— 成功拿到一份仍是 `expire_unresolved` 的响应不算解决）：①本地判到期的三条路径；②墙钟跳变后的校准；③确认轮询收尾（轮询自己会在渠道终态失败时清掉 `lakala_out_order_no`，订单因此重新进入「会被自动关闭」的集合）；④`onShow` 的刷新；⑤取消 / 回款成功后的追平刷新（写操作已落地，页面停在旧态会诱导顾客再点一次）。

⚠️ 定时器回调必须**按结果续排**（走 `_refreshOrRetry` 而非裸 `loadDetail`）：裸调用的话重试本身再失败就没人接着确认，页面会永久停在「正在确认订单状态」而实际无人在确认。

倒计时的本地截止点要锚在**响应到手那一刻**（`_lastLoadReceivedAt`），不是 `startCountdown` 执行时 —— 两者之间还隔着分组疗程卡、映射流水、setData 这一整轮视图组装，那段耗时会被凭空加进倒计时。

倒计时的本地截止点要跨 `onHide`/`onShow` 保留：`onShow` 先据此恢复计时、再由 `loadDetail` 校准。反过来（等请求回来才恢复）的话，那次请求一失败倒计时就永远回不来了。

秒数用 `Math.ceil`：`floor` 会让最后不足 1 秒的那一拍显示 `00:00`，而订单此刻仍是待支付、「去支付」照样能点——正是本 issue 要消灭的矛盾态。

页面隐藏（`onHide`）与卸载（`onUnload`）都要停表，且**在途响应回来时不许重新装表**：隐藏页拿着 1Hz 定时器会在用户看不见时归零并发后台请求；死实例上的孤儿定时器会一直 `setData` 到 `expire_at` 到点。

## 10. 优惠券集成

**下单流程**：
1. `coupon.available(storeId, skuIds)` — 查询可用券（匹配门店+商品+有效期+未使用）
2. 用户选券 → `order.create` 传入 `couponId`
3. 后端原子校验：`UPDATE user_coupons SET status='已使用' WHERE coupon_id=$1 AND status='未使用'`（rowCount=0 即券已使用）
4. 券抵扣金额写入 `sale_orders.coupon_discount`

**券与购物车独立**：券选择在结算页进行，不影响购物车状态。

## 10.1 储值卡抵扣集成

**数据模型**：`prepaid_cards` 一户一账户（`UNIQUE(user_id)`，**无 `store_id` 列**），余额跨店共享。`card_transactions` 流水（`type ∈ {'充值','扣款'}`）按 `ref_order_id` 幂等。

**扣款三处**（顾客端链路）：

| 触发点 | 场景 | 事务动作 |
|--------|------|---------|
| `order.create` | 顾客端直下单 + 全额抵扣（`paid_amount = 0`） | `SELECT balance FOR UPDATE` → 扣减 → INSERT `扣款` → 订单 `'已支付'` → `payment_method='无'` |
| `payNotify` | 微信支付成功回调（有 `pending_prepaid_card_amount > 0`） | 事务内扣 balance + INSERT `扣款` + 将实付转入 `prepaid_card_amount` + 订单 `'已支付'` |
| `order.confirmPrepaidFull` | 员工开单 → 顾客扫码 → 确认支付（`paid_amount = 0`） | 同 `order.create` 全额抵扣路径 |

**不扣款的两处关键路径**：

- `staffApi.order.create`（员工开单）：写入预选值，`balance` 不动
- `order.scanAdjust`（顾客扫码后调整）：重算 `pending_prepaid_card_amount/payable_amount/payment_method`，`balance` 不动

**幂等**：`INSERT ... WHERE NOT EXISTS (SELECT 1 FROM card_transactions WHERE ref_order_id=$1 AND type='扣款')`。

**余额不足**：任何扣款前二次 `FOR UPDATE` 校验；不足返回 `INSUFFICIENT_BALANCE`，订单保持 `'待支付'`，**不自动降级**，前端弹框由用户决定。

**退款回冲**：由员工端 `approveRefund` 驱动，按比例 `floor(prepaid/total × refund, 2)` 拆分，储值卡部分 INSERT `type='充值'` + balance 回冲。

## 11. 不包含（顾客端不实现）

| 能力 | 归属 |
|------|------|
| 开单/营业额分配/服务推进 | 员工端 |
| 权限管理 | 员工端/管理后台 |
| 数据看板/报表 | 管理后台 |
| 商品管理（CRUD） | 管理后台 |
| 券发放/模板管理 | 管理后台 |
| WorkFine 数据同步 | db/scripts 离线脚本 |
