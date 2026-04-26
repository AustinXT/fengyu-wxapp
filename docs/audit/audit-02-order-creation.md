# 审计报告：开单 + 状态机 + 订单号唯一 (02)

**审计时间**：2026-04-25
**域 ID**：02
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：partial-payment foundation (PR-2/PR-3)
**规范版本**：`real.md` v3.1.0（命中 #2 价格快照、#4 状态单向、#7 待支付唯一）+ `enums.ts` 28 枚举

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:40-117`（saleOrders）+ `db/schema/order.ts:126-188`（saleItems）+ `db/schema/order.ts:241-287`（saleOrderPayments） | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:5-14` orderStatus(8 值) + `enums.ts:16` saleOrderType(5 值) | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/orders.ts:583-1050`（createOrder）+ `:425-580`（confirmOfflinePayment / closeOrder / resetOrderFailed）+ `:1069-1516`（createConversionOrder）+ `:1522-1848`（recordPayment 回款） | `staffApi/routes/order.js:174-657`（create）+ `:662-750`（qrcode）+ `:755-1030`（confirmOffline）+ `:1035-1105`（close）+ `:1110-1146`（resetFailed）+ `:2452-2474`（generateOrderNo） | `clientApi/routes/order.js:142-550`（create）+ `:600-718`（pay）+ `:1180-1266`（alipayPay）+ `:729-794`（offlinePay）+ `:1000-1092`（cancel）+ `:888-994`（detail）+ `:51-136`（scanDetail）|
| 唯一约束 | `db/schema/order.ts:107-113`：`uq_sale_orders_client_pending` (clientUserId 待支付) + `uq_sale_orders_phone_pending`（phone+storeId 待支付，仅 client_user_id IS NULL） | ↑ | ↑ |
| Advisory lock | `actions/orders.ts:881,1280,1621` SQL 内 `pg_advisory_xact_lock(hashtext('sale_order_id_gen'))` | `routes/order.js:507,1394,2021,2460`（与 admin 同 key） | `routes/order.js:360`（同 key） |
| 前端 | `(main)/orders/_components/order-create-page.tsx` + `order-create/*-picker.tsx` + `record-payment-dialog.tsx` | `pagesOrder/*` | `pagesOrder/*` |
| 测试 | `actions/orders.test.ts` | `__tests__/order.*.spec.js`（部分） | `__tests__/order.*.spec.js`（部分） |

---

## 2. 数据流图

```
client.create
  requirePhone → closeExpiredOrdersByUser(10min) → existing 待支付检测
  → 事务：advisory_xact_lock('sale_order_id_gen')
        → 锁 prepaid_cards FOR UPDATE
        → 用 Date.UTC slice(2,10) 拼 dateStrOrder（**UTC 不是 Asia/Shanghai**）
        → SELECT MAX(sale_order_id) LIKE 'FY-XSD-WX-{YYMMDD}%'
        → claim user_coupons '已使用'（UPDATE rowCount=1）
        → INSERT sale_orders(status=待支付 或 prepaidFullPaid?'已支付':'待支付')
        → INSERT sale_items XSLSH-WX-{**YYYYMMDD**}{4}（8 位日期）
        → 全额抵扣分支：UPDATE prepaid_cards.balance + INSERT card_transactions
  → mock paymentParams（mockMode=true，未接真实微信/支付宝）

staff.create (店长)
  requireManager → effectiveStoreId 取自 ctx.auth → existing 待支付检测
  → generateOrderNo()         ← 独立事务 #1（advisory_xact_lock 释放）
  → pg.transaction(主事务)    ← 独立事务 #2（再次 advisory_xact_lock 同 key）
        → SELECT MAX(sale_item_id) LIKE 'XSLSH-WX-{YYYYMMDD}%'（YYYYMMDD 8 位）
        → claim user_coupons → INSERT sale_orders → INSERT sale_items
        → 线下/储值卡 + paid > 0 → INSERT sale_order_payments(首次支付,'staff',已支付)
  ⚠️ generateOrderNo 与主事务**两段独立事务**：第一段持锁结束（commit）后第二段再开新事务 + 新锁，
     两段中间存在窗口。saleOrderId 已落于 generateOrderNo 内，但 sale_orders 行未插，
     若第二段在 DB 写之前出错则该 id "丢号"且不影响约束（因 sale_orders 没插）。
     真正风险：advisory lock 释放后另一并发 generateOrderNo 在 SELECT 时只看已 commit 的 max(id)，
     由于第一段未插过 sale_orders，新 generateOrderNo 也会算出同 id（**重号**！）。

admin.createOrder
  getSession → requirePermission('sale_order:create') → isInScope(session, storeId)
  → db.transaction(单事务)
        → WITH lock AS (SELECT pg_advisory_xact_lock(...)) SELECT 'FY-XSD-WX-' || to_char(NOW(),'YYMMDD') ...
                                                                 ↑ 用 PG NOW() (服务器时区，由 PG `timezone` 决定，未显式 AT TIME ZONE)
        → 待支付重检 → INSERT sale_orders → INSERT sale_items（id 格式 `{orderId}-{NN}` ⚠️ 与 staff/client `XSLSH-WX-...` 不一致）
        → claim user_coupons → INSERT sale_order_payments（如线下且 received>0）

confirmOffline (staff)         confirmOfflinePayment (admin)
  WHERE status IN (...)          WHERE status='待确认收款' AND scope
  → 储值卡扣减 + 写 '储值卡抵扣' payments
  → 写 '首次支付'/'回款' payments → 重算 paid_amount → UPDATE status

payNotify(微信回调) ── 域 04 专审，本域不展开

cancel (client) → status IN ['待支付', 已支付且全额抵扣单] → '已关闭'（注意：不带 paid+prepaid=0 校验）
close (staff) → manager 可关 待支付/待确认收款/支付失败；creator 仅可关 待支付
resetFailed (staff) → manager: '支付失败' → '待支付'
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-02-01]** staff `create` 订单号生成与主事务**双事务、advisory lock 不连续**，并发下可生成重复 saleOrderId
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:410`（`generateOrderNo()` 调用）+ `:2452-2474`（`generateOrderNo` 内含 `pg.transaction` + advisory lock）+ `:505-628`（主事务再次 advisory lock）
- **现象**：`generateOrderNo` 在自己的事务内拿 `pg_advisory_xact_lock(hashtext('sale_order_id_gen'))` 计算 id 后 commit，**锁立即释放**；返回的 id 在外层主事务（行 505）开新事务前的"窗口"里 sale_orders 还未 INSERT。两个并发 staff.create 进程：A 持锁算出 id=N+1 → 释放 → 还未 INSERT；B 拿锁算 id 时只看到已 commit 的 max(id)=N（A 的 N+1 未落）→ B 也算出 N+1 → 释放 → A、B 同时 INSERT → 主键冲突。
- **风险**：高并发下店长开单失败（PK 冲突报 23505）；更严重：若 application 把异常吞掉或重试，容易写入"两单 id 重复但 saleItem 散落两单"的脏数据。违反**订单号唯一性**（§1 P0 触发条件）。
- **复现**：两个 staff.create 同时打到同一进程；time-of-check vs time-of-write 在 `generateOrderNo` 释放锁后、主事务 INSERT 前。
- **修复**：(L3) `generateOrderNo` 不要自己开事务，应当接收 `tx client` 参数在主事务内运行；或改为 `client.create` 模式（在主事务内一次性 advisory lock + 计算 + INSERT）。`client/routes/order.js:360-430` 与 `admin/actions/orders.ts:877-893` 已是正确模式可参考。

#### **[P0-02-02]** 三端订单号 `{YYMMDD}` 时区不一致，跨日时段（UTC vs Asia/Shanghai）订单号可能跨日重排或重号
- **文件**：
  - admin `actions/orders.ts:883,889,1282,1288,1623,1629`：`to_char(NOW(),'YYMMDD')` — 取 PG 服务器时区（生产 PG 实际 timezone 未在 schema 显式 SET，默认 UTC 或随集群配置）
  - staff `routes/order.js:2455`：`new Date().toISOString().slice(2,10).replace(/-/g,'')` — **UTC 强制**
  - client `routes/order.js:419`：`now.toISOString().slice(2,10).replace(/-/g,'')` — **UTC 强制**
  - sale_items id 三端：admin `routes/orders.ts:977` 用 `{orderId}-{NN}` 完全不带日期；staff `:510,601` 用 `slice(0,10)` 8 位 YYYYMMDD UTC；client `:434,483` 用 `slice(0,10)` 8 位 YYYYMMDD UTC
- **现象**：UTC 与 Asia/Shanghai 相差 8 小时。北京时间 00:00–08:00，三端 `now.toISOString()` 仍是前一天 UTC，订单号会"回退"到前一日。若 PG NOW() 是 Asia/Shanghai（OS-tz）而 application 是 UTC，admin 与 staff/client 同一时刻生成的 dateStr 不同，序号搜索 `LIKE 'FY-XSD-WX-260425%'` vs `LIKE 'FY-XSD-WX-260424%'` 命中不同前缀池 → admin 生成 `FY-XSD-WX-2604250001`，与 staff 同时生成 `FY-XSD-WX-2604240998` 互不相干，看起来正常；**但当一日跨过 UTC 边界时，admin 仍在 4/25 而 staff 已切到 4/24，两端各自 0001 重叠**。
- **风险**：违反"订单号唯一性"硬约束；财务对账日期错位（订单号嵌入的 YYMMDD 与业务实际日期不符）。
- **复现**：测试环境 PG 时区设为 Asia/Shanghai，本地北京时间 00:30 同时触发 staff/client/admin 开单 → 三端 dateStr 不一致，可造同号异日。
- **修复**：(L0) DB schema 显式 `SET timezone = 'Asia/Shanghai'`；(L3) 三端统一用 `to_char(NOW() AT TIME ZONE 'Asia/Shanghai', 'YYMMDD')`；application 侧 `new Date()` 改为 `dayjs().tz('Asia/Shanghai').format('YYMMDD')`。

#### **[P0-02-03]** client `cancel` 允许"已支付（全额抵扣）"订单关闭；条件靠应用层 `paid_amount=0` 推断，未上锁 + 状态机回退路径未走幂等保护
- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/order.js:1020-1085`
- **现象**：`cancelableStatuses` 在 `paid_amount=0 && prepaid_card_amount>0 && status='已支付'` 时追加 `'已支付'`。这是**状态单向推进**（real.md #4）的破例 —— 已支付 → 已关闭。判定逻辑 1) 没用 `FOR UPDATE` 锁 sale_orders；2) UPDATE 没用 `WHERE status='已支付'` CAS 守卫，仅 `WHERE sale_order_id = $1`。
- **风险**：并发下顾客自助 cancel 与店长 confirmOffline / 服务单 service.start 竞争：
  - 顾客本地 detail 看到 `已支付` → 触发 cancel → SELECT 完成 → 中间 service.start 把 remaining_sessions 扣到 0；
  - cancel 直接 UPDATE status='已关闭'，但 sale_items 已被服务单关联，造成"已关闭订单上已被服务掉的次数"幽灵数据。
  - 更严重：刚被 admin 录入 receivable 的 prepaidFull 单，admin 还没来得及触发任何后续，顾客自助 cancel 退卡 + 关单。
- 复现：1) 创建 prepaidFull 已支付订单；2) staff 开始 service.start；3) client 触发 cancel（同时）。
- **修复**：(L3) cancel UPDATE 加 `AND status = $expectedStatus` CAS（与 client.closeExpiredOrder 模式对齐）；用 SELECT FOR UPDATE 锁主行；增加 sale_items.remaining_sessions 与 service_orders 关联检查（任一已被服务单引用即拒绝 cancel）。

#### **[P0-02-04]** staff `confirmOffline` 在事务中跨多张表 UPDATE，但**积分结算 + 分享礼**写在同事务且失败回滚整笔收款
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:840-1018`
- **现象**：line 992 `await settlePointsSafe(client, saleOrderId, 'staffApi.confirmOffline')` 在主事务里调用；分享礼 line 999-1017 用 `SAVEPOINT sp_share_gift` 隔离了。但**积分结算未用 SAVEPOINT**：若积分模块抛出（如 customer_points 行被并发触发器锁），整个 confirmOffline 事务回滚 = 顾客已给现金、扣储值卡的 UPDATE 全部回滚 = 资损。
- **风险**：店长确认收款后系统报错，店里已收到现金但 PG 里订单仍 `待确认收款`。
- **复现**：手动把 `customer_points` 表锁住（pg_locks），触发 confirmOffline → 应观测到现金已收 但状态未推进。
- **修复**：(L3) 把 `settlePointsSafe` 也包在 SAVEPOINT 里，与分享礼同样降级为非阻塞；或确保 settlePointsSafe 内部已用 SAVEPOINT。
- 验证：`grep -n SAVEPOINT staffApi/utils/points.js`（未在本次审计范围读取，但若该 helper 内部已 SAVEPOINT 则该项降级为 P1）。

#### **[P0-02-05]** admin `recordPayment` 不做 `isInScope` 校验，依赖 `sale_order:record_payment` 权限只发给 admin 角色（隐式合约）
- **文件**：`fengyu-admin/src/actions/orders.ts:1531,1593-1594`
- **现象**：注释明确写 "scope 保护：非 admin 的 record_payment 由权限矩阵拒绝，此处 admin 默认可跨门店；若未来扩展该权限到 scoped 角色，需要在此处做 isInScope(session, locked.store_id) 校验。"。
- **风险**：未来 `permission_matrix` 一改（财务/区经被授权 record_payment）即破，跨门店越权回款。
- **复现**：把 `sale_order:record_payment` 加到 manager → 任意 manager 可对全部门店订单回款。
- **修复**：(L7) 直接在 `recordPayment` 里强制 `isInScope(session, locked.store_id)`，不依赖未来 PERMISSION_MATRIX 维护。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-02-06]** sale_items `sale_item_id` 命名格式三端不一致（admin vs staff/client）
- **文件**：admin `actions/orders.ts:977` `\`${id}-${String(i+1).padStart(2,'0')}\`` 例：`FY-XSD-WX-2604250001-01`（变长，含中划线）  vs  staff `routes/order.js:601` 与 client `routes/order.js:483` 都用 `XSLSH-WX-{YYYYMMDD}{4}`（30 字符上限内固定格式）
- **现象**：schema `db/schema/order.ts:129` `varchar("sale_item_id", { length: 30 })`。admin 的 `FY-XSD-WX-2604250001-01` 长度 22，未超长但**和 staff/client 的 XSLSH-WX-... 不同前缀**。
- **风险**：
  - 任何按前缀匹配 sale_item_id 的报表/查询会漏数（grep `XSLSH-WX-` 找不到 admin 单）
  - 退款/转换继承 ref_sale_item_id 时字段长度足够，但下游脱敏/序列化逻辑可能假定固定 18 字符；
  - admin createConversion `routes/orders.ts:2199` 用 `XSLSH-WX-...{4}` 创建转入行，意味着同一系统内 admin 既产 `XSLSH-WX-` 又产 `{orderId}-NN`，混格式。
- **修复**：(L0/L7) 统一为 `XSLSH-WX-{YYYYMMDD}{4}` 格式 + advisory lock；admin createOrder 改为与 createConversion 一致。

#### **[P1-02-07]** orderStatus 枚举 8 值，但状态机迁移路径文档化缺失，三端各自实现允许集
- **现象**：
  - `db/schema/enums.ts:5-14`：`待支付 / 待确认收款 / 已支付 / 已完成 / 支付失败 / 已关闭 / 待审批 / 部分支付` 共 8 值
  - admin `closeOrder:509`：允许从 `待支付 OR 支付失败` → `已关闭`
  - staff `close:1058,1062`：manager 允许 `待支付 / 待确认收款 / 支付失败` → `已关闭`；creator 仅 `待支付`
  - staff `confirmOffline:780`：允许 `待确认收款 / 待支付 / 部分支付` → `已支付/部分支付`
  - admin `confirmOfflinePayment:450`：仅允许 `待确认收款` → `已支付`
  - client `cancel:1023,1026`：允许 `待支付 OR (已支付 AND 全额抵扣)` → `已关闭`
  - resetFailed (staff:1128) / resetOrderFailed (admin:563)：仅 `支付失败` → `待支付`
- **不一致**：admin closeOrder 不允许 `待确认收款` 关闭，但 staff close manager 允许；staff confirmOffline 允许 `待支付` 直接转 `已支付/待确认收款`，admin 等价路径走 createOrder 内决策树或 record-payment。同一状态机三端规则不闭合。
- **风险**：admin 拒绝关闭的 `待确认收款` 单店长在小程序能关；admin / staff 的"操作日志中"状态前置不同 → 审计混乱。
- **修复**：(L0) 在 `.42cog/cog.md` 增加 orderStatus 状态机权威图；(L7+L3) 统一三端允许迁移集合；(L0) 考虑 PG `CHECK` 约束 + trigger 防止非法 UPDATE。

#### **[P1-02-08]** 订单号前缀语义重叠：`FY-XSD-WX-` 同时被销售单 + 转换单 createConversion 使用
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2018`、`fengyu-admin/src/actions/orders.ts:1282` 均用 `FY-XSD-WX-` 前缀生成转换单。
- **现象**：转换单 sale_order_type='转换单'，但订单号前缀仍为 `FY-XSD-WX-`，外观与销售单完全相同；只能靠 `sale_order_type` 字段区分。退款 / 回款分别用 `FY-TKD-WX-` / `FY-HKD-WX-` 与单据类型语义对齐。
- **风险**：肉眼审单 / 财务报表按订单号前缀分组会把转换单误归销售；订单号查询索引混。
- **修复**：(L0/L3) 转换单引入独立前缀 `FY-ZHD-WX-`（或类似），与 saleOrderType 一一对应；同时更新 admin / staff 双端 generateOrderNo 调用方。

#### **[P1-02-09]** staff.create 不写 `allocation_status` 初值，与 admin createOrder（`'待分配'`）口径不齐
- **文件**：staff `routes/order.js:558-577` INSERT 列集未含 `allocation_status`；admin `actions/orders.ts:934` 显式写 `allocationStatus: '待分配'`
- **现象**：DB 默认值无（`db/schema/order.ts:79` `allocation_status` 无 `.default(...)`）→ staff.create 写入的订单 `allocation_status = NULL`；后续 staff `confirmOffline:898` 才会 SET `'待分配' / '已分配'`。
- **风险**：管理后台「待分配清单」按 `allocation_status='待分配'` 过滤会漏掉所有刚开未确认的店长单。
- **修复**：(L3) staff.create INSERT 追加 `allocation_status = '待分配'`；或(L0) 让 schema 加默认值 `.default('待分配')`。

#### **[P1-02-10]** client.create 在事务内**两次**计算 dateStr，订单号 `slice(2,10)`（YYMMDD 6 位）vs item id `slice(0,10)`（YYYYMMDD 8 位），都基于同一个 `now`
- **文件**：`clientApi/routes/order.js:419` vs `:434`
- **现象**：变量名都叫 `dateStrOrder`/`dateStr`，但取的位数不同。功能正常；属于代码味道。schema `sale_item_id varchar(30)` 容纳 `XSLSH-WX-2026042500001`(20 字符) 没问题。
- **风险**：若未来要给 sale_items 也建 unique index 按日序号，6/8 位混用会导致歧义匹配。
- **修复**：(L3) 统一为同一格式（`YYMMDD` 6 位与订单号对齐，长度更紧凑）；同时 staff 端对齐。

#### **[P1-02-11]** 待支付订单唯一约束在 client_phone+storeId 维度漏覆盖跨店重号
- **文件**：`db/schema/order.ts:111-113`：`uq_sale_orders_phone_pending` ON `(client_phone, store_id) WHERE status='待支付' AND client_user_id IS NULL`
- **现象**：店长开单先校验 `client_wechat_users` 已注册（routes/order.js:240-242 `bound_store_id` 必须）才允许下单；故 `client_user_id` 必填，phone+storeId 唯一索引基本不会触发。但**真正未注册的顾客（admin createOrder 走 RECHARGE_VIRTUAL_SKU 跳过此校验）**理论可走 client_user_id IS NULL 路径，且 admin createOrder line 626 强制要求 clientUserId（必传）—— 实际所有路径都注入 client_user_id。所以 phone+store 索引只防"未注册"残留场景。
- **风险**：phone+store 索引允许跨店一人多单（`(phone='13900', store_A)` 与 `(phone='13900', store_B)` 都待支付）。real.md #7 「同一顾客同一时间至多 1 笔待支付」按"顾客=user_id"语义已被 `uq_sale_orders_client_pending` 覆盖；但若一日内同一手机号在 A 店没注册下单、又在 B 店注册下单（client_user_id 已绑定），则 `(phone, store_A) 索引` 不锁 `(client_user_id, *) 索引` → 形成两单待支付。
- **修复**：(L0) 把 `uq_sale_orders_phone_pending` 拓宽为仅按 `(client_phone) WHERE status='待支付' AND client_user_id IS NULL`（删除 store_id 维度）；或（L3）在 client/staff/admin create 分支显式 SELECT 跨店全网检查。

#### **[P1-02-12]** sale_orders.totalAmount NUMERIC(10,2)，三端价格计算 JS Number 加减再 round，不足以 amplify 实战风险但不规范
- **文件**：staff `routes/order.js:411` `Math.round(sum * 100) / 100`；client `routes/order.js:329` 等。
- **现象**：所有"先 JS Number 累加再 *100/round"。在 ≤10 位 + 2 位小数范围内 IEEE-754 精度足够（金额单位为元，最大 99999999.99 < 2^53）；CC1 检查项满足底线。
- **修复**：(L3) 引入 dinero.js / decimal.js 统一货币运算；属 P1 改进。

#### **[P1-02-13]** mock 微信支付串号：client.pay 和 alipayPay 写出 `prepay_id=wx{Date.now()}`，三端联调可能误以为已发起真实支付
- **文件**：`clientApi/routes/order.js:712, 1262`
- **现象**：返回 `mockMode: true` + 空签名 `paySign: 'mock_sign'` + `totalFee: Math.round(thisPayAmount * 100)`。注释 `TODO: 接入真实微信支付统一下单接口`。线上**未接真支付**。
- **风险**：本环节不触发支付通道，全部依赖 payNotify 模拟回调；对 P0 域 04（payNotify 幂等）的真实回放路径仍是黑盒。
- **修复**：（L3）正式接入；至少 mock 时显式标记金额为 0、显式 `if (mockMode) return mockResult` 并打日志。

### 3.3 P2（代码质量 / 可维护）

#### **[P2-02-14]** staff create / confirmOffline / close 大量复制粘贴 dateStr 计算 + advisory lock + max id 查询逻辑
- **文件**：`routes/order.js:507-520, 1394-1402, 2018-2030, 2186-2199, 2240-2247`
- **修复**：(L3) 抽 `helpers/order-id.js`（generate(prefix, tx, dateStr) → id）。

#### **[P2-02-15]** client.create / staff.create 内嵌 200+ 行优惠券处理，优惠券处理逻辑 admin / staff / client 三端独立实现，复杂度+维护风险
- **文件**：staff:325-407, client:244-331, admin:746-775
- **修复**：(L3) 抽 `helpers/coupon-discount.js`（calc + distribute）。

#### **[P2-02-16]** scanDetail / detail / list 多次重复 `LEFT JOIN stores`、`LEFT JOIN staff_wechat_users`，SQL 不复用
- **修复**：(L3) 引入 helpers/order-formatter.js。

#### **[P2-02-17]** 错误前缀混用：staff.create line 241 `CLIENT_NOT_REGISTERED:` / line 432 `INSUFFICIENT_BALANCE:` / line 469 `INVALID_PARAMS:MIXED_PAYMENT_NOT_SUPPORTED:`，**不在 4 种约定前缀内**
- **文件**：staff `routes/order.js:241, 432, 469`；client `routes/order.js:389`
- **现象**：约定（CLAUDE.md / audit_plan.md §1）仅 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:` 四种。前端按前缀做 toast 文案映射时会落入"未识别错误"分支。
- **修复**：(L3) 统一改为 `INVALID_PARAMS:CLIENT_NOT_REGISTERED:` / `INVALID_PARAMS:INSUFFICIENT_BALANCE:` 嵌套语义；或扩约定。

#### **[P2-02-18]** qrcode 模块级缓存 `qrcodeCache = new Map()` 无淘汰，云函数容器复用时无限增长
- **文件**：`staffApi/routes/order.js:27`
- **修复**：(L3) 改 LRU + size cap（与 auth.js AUTH_CACHE 同模式）。

#### **[P2-02-19]** dispatch 路径上 `pg.query(...)` 与 `client.query(...)` 返回结构不同（前者直接 rows 数组，后者返回 {rows}）容易误用
- **现象**：staff `routes/order.js:519` `if (maxResult.rows.length > 0)`；client `routes/order.js:38` `for (const row of expired)` —— 同一路由文件内两种返回 shape 不一致。已注释（client.calcPaymentRemaining:577 "pg.query 返回 rows 数组（见 db/pg.js），不需要 .rows 解包"）但仍有 misuse 风险。
- **修复**：(L3) 统一签名；TS 类型保护。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| sale_item_id 格式 | `{orderId}-{NN}` 例 `FY-XSD-WX-2604250001-01` | `XSLSH-WX-{YYYYMMDD}{4}` | `XSLSH-WX-{YYYYMMDD}{4}` | 报表前缀分组失效；同 admin 内 createOrder 与 createConversion 互不一致 | P1（[P1-02-06]） |
| 订单号 dateStr 来源 | `to_char(NOW(),'YYMMDD')`（PG 时区） | `new Date().toISOString().slice(2,10)`（UTC） | `now.toISOString().slice(2,10)`（UTC） | 跨时区窗口可重号 | P0（[P0-02-02]） |
| advisory lock 持有 | 单事务持锁直到 commit ✅ | generateOrderNo 独立事务 → 主事务再开新事务 ❌ | 单事务持锁 ✅ | 重号窗口 | P0（[P0-02-01]） |
| state machine: 关闭 | `待支付 / 支付失败` | `待支付 / 待确认收款 / 支付失败`(manager) | `待支付 / (已支付 全额抵扣)` | 三端各自一套规则 | P1（[P1-02-07]） |
| state machine: confirm | 仅 `待确认收款` | `待支付 / 待确认收款 / 部分支付` | — | staff 比 admin 宽 | P1（[P1-02-07]） |
| `allocation_status` 初值 | 显式 `'待分配'` ✅ | 不写（NULL）❌ | 不写（NULL，自助单）但走 payNotify 后未必修正 | 待分配清单漏单 | P1（[P1-02-09]） |
| 错误前缀 | 全裸 throw `Error(msg)` | `INVALID_PARAMS:` + 自定义 `CLIENT_NOT_REGISTERED:` | `INVALID_PARAMS:` + `INSUFFICIENT_BALANCE:` | 前端文案映射落空 | P2（[P2-02-17]） |
| 内部单半价处理 | 入口前对 items 全部 ×0.5（`actions/orders.ts:701-718`）✅ | `unitPrice = round(basePrice*50)/100` 行级 ✅ | client 不允许内部单 | 一致 | OK |
| 储值卡抵扣写流水时机 | createOrder 不写 `储值卡抵扣` payments，由 confirmOffline 统一写 | 同 | 全额抵扣场景 client.create 直接扣 balance + status=已支付，**但 sale_order_payments 不写 `储值卡抵扣` 行** ❌ | client 全额抵扣单 payments 表无记录，与 admin/staff 路径不对账 | P0（建议归 03） |
| 订单号前缀 | `FY-XSD-WX-`（销售/转换共用）+ `FY-HKD-WX-` + `FY-TKD-WX-` | 同 | 仅 `FY-XSD-WX-` | 转换 vs 销售前缀冲突 | P1（[P1-02-08]） |

---

## 5. 横切检查（套用 §3）

- [ ] **CC1 数值精度**：金额 NUMERIC(10,2) ✅；JS 用 `Math.round(*100)/100` 风险面有限但不规范（[P1-02-12]）。提成比例在域 07 审。
- [ ] **CC2 并发与幂等**：advisory lock 三端基本到位，但 staff.create 双事务[P0-02-01]、cancel 无 CAS [P0-02-03]、client 全额抵扣 cancel 路径无显式 CAS。退款单注单 noteLIKE 'FY-TKD=...' 当幂等键过于脆弱。
- [x] **CC3 组织域数据隔离**：staff.confirmOffline / close / resetFailed / list 都用 `effectiveStoreId` 过滤；admin 用 `scopeCondition()` ✅；recordPayment 缺 isInScope（[P0-02-05]）。client 全部 `WHERE client_user_id = userId` ✅。
- [ ] **CC4 后端统一鉴权**：staff 用 `requireManager` / `requireStaffBound`、admin 用 `requirePermission` ✅；但 admin recordPayment 假设权限矩阵保护 [P0-02-05]，client.scanDetail 无 `requirePhone` 守卫（line 51-136 直接读 `ctx.event.payload`，未校验 ctx.auth），意味着未绑定手机号也能扫码看订单详情；scanDetail 仅查 `opened_by IS NOT NULL` 但任意有 OPENID 的用户可枚举 saleOrderId 看他人订单。
- [ ] **CC5 错误前缀**：staff/client 大量自定义前缀（`CLIENT_NOT_REGISTERED:`、`INSUFFICIENT_BALANCE:`、`MIXED_PAYMENT_NOT_SUPPORTED:`）不在 4 种约定内（[P2-02-17]）；admin 错误均为中文字符串，无前缀（继承域 01 P2-ERROR-12）。
- [ ] **CC6 PII**：sale_orders 含 `customer_name` + `client_phone` 快照；scanDetail 返回 `clientPhone`、`customerName` 完整；listing log 写完整 phone（参考 audit-01 P0-PII-06）。
- [x] **CC7 时间字段**：`createdAt` / `updatedAt` defaultNow ✅；`paid_at` 由各 update 显式写 ✅；`saleOrderDatetime` 是业务时间（INSERT 时 = `now`）✅。但 dateStr UTC vs PG NOW 时区不一致（[P0-02-02]）。
- [x] **CC8 WXML/Vant**：本域无前端 WXML 直接审计，scope 在域 06/13 等。
- [ ] **CC9 测试与残留**：admin 已有 `actions/orders.test.ts`（域 01 提及）；staff/client 有 `__tests__/order.*.spec.js` 但需验证 advisory lock 双事务模式是否有覆盖测试。废弃字段（`order_no`/`item_flow_no`/`store_name`/`customer_name`/`staff_name`）已在 schema 重命名，但 client.scanDetail 仍 SELECT `s.store_name AS store_name`（schema 里 stores.store_name 仍存在，无残留），未发现死字段引用。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/order.ts:111-113` | `uq_sale_orders_phone_pending` 移除 `store_id` 维度 | P1-02-11 |
| L0 schema | `db/schema/order.ts` | `allocation_status` 列 `.default('待分配')` | P1-02-09 |
| L0 schema | （新建 migration） | `SET timezone='Asia/Shanghai'` 集群级 | P0-02-02 |
| L0 schema | `db/schema/enums.ts` | 维持 8 值 orderStatus；新增独立前缀 `FY-ZHD-WX-` 转换单（前缀是 application 层，无 enum） | P1-02-08 |
| L3 staffApi | `staffApi/routes/order.js:2452` | `generateOrderNo(prefix, tx)` 接收事务 client，禁止内部 `pg.transaction` | P0-02-01 |
| L3 staffApi | `staffApi/routes/order.js:557` | INSERT sale_orders 列集补 `allocation_status='待分配'` | P1-02-09 |
| L3 staffApi | `staffApi/routes/order.js:992` | `settlePointsSafe` 包 SAVEPOINT 或确认其内部已隔离 | P0-02-04 |
| L3 staffApi | `staffApi/routes/order.js:241,432,469` | 错误前缀统一为 `INVALID_PARAMS:CLIENT_NOT_REGISTERED:` 等嵌套形式 | P2-02-17 |
| L3 staffApi | `staffApi/routes/order.js:27` | qrcodeCache LRU 化 | P2-02-18 |
| L3 staffApi | `helpers/order-id.js`（新文件） | 抽公共 advisory lock + dateStr + maxSeq → id | P0-02-01, P2-02-14 |
| L3 clientApi | `clientApi/routes/order.js:1045` | cancel UPDATE 加 `AND status = $expectedStatus`；先 SELECT FOR UPDATE | P0-02-03 |
| L3 clientApi | `clientApi/routes/order.js:419,434` | dateStr 改用 Asia/Shanghai；统一长度 | P0-02-02, P1-02-10 |
| L3 clientApi | `clientApi/routes/order.js:51` | scanDetail 加 `requirePhone()`；URL ID 校验来源（防枚举） | CC4 |
| L7 admin | `actions/orders.ts:1531` | `recordPayment` 强制 `isInScope(session, locked.store_id)` | P0-02-05 |
| L7 admin | `actions/orders.ts:977` | sale_item_id 改用 `XSLSH-WX-{YYMMDD}{4}` 与 staff/client 对齐 | P1-02-06 |
| L7 admin | `actions/orders.ts:506,564` | closeOrder / resetOrderFailed 状态机允许集与 staff 对齐 | P1-02-07 |
| L9 前端 | `_components/order-create-page.tsx` | UI 提示状态机非法跳变 | P1-02-07 |

---

## 7. 验证 SQL（5434/fengyu，仅 SELECT / EXPLAIN）

```sql
-- 1. 验证待支付订单唯一约束当前是否被破坏（同顾客双待支付）
SELECT client_user_id, COUNT(*) AS cnt, ARRAY_AGG(sale_order_id) AS ids
FROM sale_orders
WHERE status = '待支付' AND client_user_id IS NOT NULL
GROUP BY client_user_id HAVING COUNT(*) > 1;

-- 2. 验证 phone+store 待支付重复（[P1-02-11] 是否曾发生）
SELECT client_phone, COUNT(*) AS stores, ARRAY_AGG(DISTINCT store_id) AS store_ids
FROM sale_orders
WHERE status = '待支付' AND client_user_id IS NULL
GROUP BY client_phone HAVING COUNT(*) > 1;

-- 3. 三端 saleOrderId 前缀分布（验证转换单是否混在 FY-XSD- 前缀）
SELECT
  CASE
    WHEN sale_order_id LIKE 'FY-XSD-WX-%' THEN 'FY-XSD'
    WHEN sale_order_id LIKE 'FY-HKD-WX-%' THEN 'FY-HKD'
    WHEN sale_order_id LIKE 'FY-TKD-WX-%' THEN 'FY-TKD'
    ELSE 'OTHER' END AS prefix,
  sale_order_type,
  COUNT(*) AS cnt
FROM sale_orders GROUP BY 1, 2 ORDER BY 1, 2;

-- 4. sale_item_id 格式分布（验证 [P1-02-06]）
SELECT
  CASE
    WHEN sale_item_id LIKE 'XSLSH-WX-%' THEN 'XSLSH-WX (staff/client)'
    WHEN sale_item_id LIKE 'FY-%-WX-%-%' THEN 'orderId-NN (admin)'
    ELSE 'OTHER' END AS fmt,
  COUNT(*) AS cnt
FROM sale_items GROUP BY 1;

-- 5. 验证 allocation_status NULL 比例（[P1-02-09]）
SELECT
  status,
  allocation_status,
  COUNT(*) AS cnt
FROM sale_orders
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 6. 重号订单号检测（[P0-02-01]/[P0-02-02]）
SELECT sale_order_id, COUNT(*) FROM sale_orders GROUP BY 1 HAVING COUNT(*) > 1;
-- 期望 0 行；任何 > 1 即审计现场抓到重号

-- 7. 状态机非法历史检测（已支付 → 已关闭 路径，[P0-02-03]）
-- 需要 operation_logs 配合
SELECT entity_id, before_status, after_status, COUNT(*)
FROM operation_logs
WHERE entity_type = 'sale_order' AND action = 'order.close'
  AND before_status = '已支付' AND after_status = '已关闭'
GROUP BY 1, 2, 3;

-- 8. PG 实例时区（验证 [P0-02-02] 真实风险面）
SHOW TIMEZONE;
SELECT current_setting('TIMEZONE'), NOW(), NOW() AT TIME ZONE 'Asia/Shanghai';

-- 9. 同一日期上 (sale_order_id, ?) 重复（应为 0）
SELECT SUBSTRING(sale_order_id FROM 11 FOR 6) AS dt,
       COUNT(*) AS cnt,
       COUNT(DISTINCT sale_order_id) AS uniq
FROM sale_orders WHERE sale_order_id LIKE 'FY-XSD-WX-%'
GROUP BY 1 HAVING COUNT(*) <> COUNT(DISTINCT sale_order_id);
```

---

## 8. 回归测试用例（建议）

1. **并发开单生成订单号**：fork 两个 staff.create 协程同时调用，断言两个 saleOrderId 不重复（验 [P0-02-01]）。
2. **跨午夜跨时区**：mock UTC `2026-04-25 23:50` + Asia/Shanghai `2026-04-26 07:50`，三端各开一单，验订单号 dateStr 一致（验 [P0-02-02]）。
3. **client.cancel 已支付（全额抵扣）幂等**：触发两次 cancel；第二次应返回 NOT_FOUND 或保持已关闭，断言只回冲 1 次 prepaid_card_amount（验 [P0-02-03]）。
4. **staff.confirmOffline 积分模块崩溃**：mock `settlePointsSafe` throw，断言整个 confirmOffline 事务回滚，订单仍 `待确认收款`，无 partial 状态（验 [P0-02-04]）。
5. **状态机非法迁移**：`已支付` 单 → 调 admin.closeOrder（应被拒）→ 调 staff.close（manager）（也应拒）（验 [P1-02-07]）。
6. **优惠券并发使用**：两个 client.create 并发使用同一 couponId，断言只有一个成功（已用 UPDATE rowCount=1 守卫）。
7. **prepaidFullPaid race**：client 余额 = X；同时（a）client.create 抵扣 X 全额；（b）client.cancel 还在执行；断言不会出现 balance < 0。
8. **sale_item_id 格式回归**：admin createOrder 后断言 sale_item_id LIKE 'XSLSH-WX-%'（验 [P1-02-06] 修复）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（订单号格式、状态机、allocation_status 默认值）
- 修复成本：M（schema 改动小但需 baseline 协调；application 改动覆盖 3 端 4 个文件）

---

## 10. 后续待办

- [ ] 与域 03（款项流水）对齐："储值卡抵扣" payments 行的写入责任 — client 全额抵扣 create 路径未写
- [ ] 与域 04（payNotify 幂等）对齐：mock 微信支付如何转入真实回调
- [ ] 与域 05（服务单扣次原子性）对齐：cancel 已支付路径与 service.start 的竞争
- [ ] 与域 07（销售提成分配）对齐：allocation_status 状态写入触发点
- [ ] 与域 23（操作日志）对齐：staff.close / staff.confirmOffline 是否写 operation_logs（本审计未发现 logOperation 调用，可能漏审计）

---

## 横切归集追加

- CC2 → CROSS-CUTTING.md 新增 "advisory lock 跨事务释放窗口"（P0-02-01）
- CC2 → CROSS-CUTTING.md 新增 "状态机非 CAS UPDATE"（P0-02-03）
- CC4 → CROSS-CUTTING.md 新增 "admin scope 隐式合约"（P0-02-05）
- CC5 → 后续命中：staff/client 自定义错误前缀偏离 4 种约定（[P2-02-17]）
- CC7 → CROSS-CUTTING.md 新增 "时区不一致：UTC vs PG NOW vs Asia/Shanghai"（P0-02-02）

## Schema 修改建议追加

- S02-1 `uq_sale_orders_phone_pending` 索引去掉 store_id 维度（P1-02-11）
- S02-2 `sale_orders.allocation_status` 加默认值 `'待分配'`（P1-02-09）
- S02-3 集群级 `SET timezone = 'Asia/Shanghai'`（P0-02-02）

## 枚举发现追加

- E02-order-status：8 值齐全 ✅；三端允许迁移子集不一致 → 文档化建议（不改枚举）
- E02-sale-order-type：5 值齐全 ✅；订单号前缀只 3 套（FY-XSD/FY-HKD/FY-TKD），转换单复用 FY-XSD（[P1-02-08]）
