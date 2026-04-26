# 枚举一致性审计归集（ENUM-AUDIT）

记录每轮审计中发现的枚举值集合不一致、新增/废弃建议。最终汇总到 SUMMARY.md。

权威来源：`db/schema/enums.ts`（28 个枚举）。

---

## 来自域 01（认证 / 鉴权）

无枚举发现（认证域无业务枚举依赖）。涉及的 4 种错误前缀（`UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`）属于约定常量而非 PG 枚举，已记录在 [CROSS-CUTTING.md CC5](./CROSS-CUTTING.md#cc5-错误码与错误前缀)。

---

## 来自域 02（开单 + 状态机 + 订单号唯一）

### E02-order-status
- **枚举名**：`orderStatusEnum`（`db/schema/enums.ts:5-14`）
- **权威值**：`待支付 / 待确认收款 / 已支付 / 已完成 / 支付失败 / 已关闭 / 待审批 / 部分支付`（共 8 值）
- **三端使用差异**：
  - admin `closeOrder` 允许集：`待支付 OR 支付失败` → `已关闭`
  - staff `close` (manager) 允许集：`待支付 / 待确认收款 / 支付失败` → `已关闭`
  - client `cancel` 允许集：`待支付` 或 `(已支付 AND prepaid_card_amount>0 AND paid_amount=0)` → `已关闭`
  - admin `confirmOfflinePayment` 仅允许：`待确认收款` → `已支付`
  - staff `confirmOffline` 允许：`待确认收款 / 待支付 / 部分支付` → `已支付/部分支付`
  - 状态 `待审批` 仅 `db/schema/enums.ts` 中存在，三端 order routes 未消费（看似为退款单 sale_order_type='退款单' 复用 status='待审批'，参见 staffApi/routes/order.js refundList）
- **风险**：admin 拒关闭的 `待确认收款` 单店长在小程序可关；admin/staff 操作日志状态前置不同 → 审计混乱。
- **建议**：（不改枚举集）在 `.42cog/cog.md` 增加 orderStatus 状态机权威图；三端逐路由对齐允许迁移集合（`audit-02 §3.2 P1-02-07`）

### E02-sale-order-type
- **枚举名**：`saleOrderTypeEnum`（`db/schema/enums.ts:16`）
- **权威值**：`销售单 / 内部单 / 回款单 / 转换单 / 退款单`（共 5 值）
- **三端使用差异**：
  - 订单号前缀仅 3 套：`FY-XSD-WX-`（销售单 + 转换单复用）/ `FY-HKD-WX-`（回款单）/ `FY-TKD-WX-`（退款单）
  - 内部单使用 `FY-XSD-WX-` 前缀，与销售单完全相同（仅靠 saleOrderType 字段区分）
- **风险**：肉眼审单 / 财务报表按订单号前缀分组会把转换单 / 内部单误归销售；订单号查询索引语义混。
- **建议**：（不改枚举）转换单引入独立前缀 `FY-ZHD-WX-`；内部单按业务约定可复用 `FY-XSD-WX-`（建议在 documentType 字段或 remark 中显式标记）

### E02-payment-method（间接命中）
- **枚举名**：`paymentMethodEnum`（`db/schema/enums.ts:22`）
- **权威值**：`微信 / 支付宝 / 线下 / 无 / 储值卡`（共 5 值）
- **三端使用差异**：
  - admin `createOrder` 入参类型 `'微信' | '支付宝' | '线下'`（不允许传 `无 / 储值卡`，由后端在 `payable_amount=0 ⇔ payment_method='无'` 的不变量推导）
  - staff `create` line 209 白名单 `['微信','线下']`（**不接受 `支付宝`**），与 admin / client 不同
  - client `create` line 407 白名单 `['微信','支付宝','线下']`
- **风险**：staff 端店长开单时无法选支付宝，但 admin 和 client 都可以，员工端业务能力缺口。
- **建议**：staff 补 `支付宝` 或在 PRD 中明确"店长开单不允许支付宝"

---

## 来自域 03（款项流水 sale_order_payments）

### E03-payment-change-type
- **枚举名**：`paymentChangeTypeEnum`（`db/schema/enums.ts:34-39`）
- **权威值**：`首次支付 / 回款 / 退款 / 储值卡抵扣`（共 4 值）
- **三端使用差异**：
  - admin: createOrder 写 '首次支付'（仅线下/储值卡/无 + receivedAmount>0）；recordPayment 写 '回款' + '储值卡抵扣'；confirmOfflinePayment **不写任何 payments 行**（P0-03-01）
  - staff: create 写 '首次支付'；confirmOffline 写 '首次支付'/'回款' + '储值卡抵扣'；createRepayment 写 '回款' + '储值卡抵扣'；createRefund 写 '退款' (status='待支付')；approveRefund 翻 '退款' status→'已支付'
  - client: create 全额储值卡抵扣分支 **不写 '储值卡抵扣'**（P0-03-02）；confirmPrepaidFull **不写 '储值卡抵扣'**（P0-03-02）；repay 写 '回款'（储值卡通道）
  - payNotify: 写 '首次支付'/'回款'（线上）
- **风险**：'储值卡抵扣' 枚举值 4 端中 client 端漏写两处，破坏 schema 注释定义的 prepaid_card_amount 不变量。
- **建议**：补全 client 端两处缺失写入；schema 注释（order.ts:235）刷新（见 SCHEMA-CHANGES.md S03-5）。

### E03-payment-flow-status
- **枚举名**：`paymentFlowStatusEnum`（`db/schema/enums.ts:49-54`）
- **权威值**：`待支付 / 已支付 / 已作废 / 已退款`（共 4 值）
- **三端使用差异**：
  - 写入端：staff createRefund 写 status='待支付'（其他场景全部直接 '已支付'）
  - 翻转端：staff approveRefund 翻 '待支付'→'已支付'；staff rejectRefund 翻 '待支付'→'已作废'
  - **`已退款` 值零使用**：grep 结果三端 + payNotify 均无任何 `'已退款'` 字面量。schema 注释（enums.ts:53）说明"首次支付/回款行整笔退款时置此"，但代码上从未实现。
- **风险**：枚举值定义但无消费者，dead value；如未来真要实现整笔退款，会与"退款单 + 退款行 status='已支付'"语义冲突。
- **建议**：（待业务确认）（A）从枚举中移除 '已退款'；（B）保留但在 spec 中明确何时启用（与退款单语义区分）

### E03-payment-source-end
- **枚举名**：`paymentSourceEndEnum`（`db/schema/enums.ts:59-64`）
- **权威值**：`client / staff / admin / notify`（共 4 值）
- **三端使用差异**：硬编码与端别一致（admin 写 'admin'，staff 写 'staff'，client 写 'client'，payNotify 写 'notify'）。OK。
- **风险**：admin 端的 confirmOfflinePayment（不写）vs createOrder（写 'admin'）vs recordPayment（写 'admin'）三种语义共用同一 source_end='admin' 难审计——见 P1-03-07。
- **建议**：保留 4 值；（可选）增加 metadata.adminAction 字段细分。

### E03-payment-method（与 E02 联动）
- **枚举名**：`paymentMethodEnum`（`db/schema/enums.ts:22`）
- **本域使用**：sale_order_payments.payment_method 与 sale_orders.payment_method 共用同一枚举。CHECK `chk_sop_method_txn` 对线上（微信/支付宝）要求 external_txn_id 非空——OK。staffApi/routes/order.js:1456 退款行 payment_method 经 resolveRefundPaymentMethod 映射，把"微信/支付宝"通道退款降级为 '线下' 以避免 external_txn_id NOT NULL CHECK 触发——是过渡期权宜方案，后续接入三方 refund API 后需移除映射。
- **关联**：见 audit-02 ENUM E02-payment-method

---

## 来自域 04（支付回调 payNotify 幂等）

### E04-payment-method（payNotify 信任 event 入参）
- **枚举名**：`paymentMethodEnum`（`db/schema/enums.ts:22`）
- **权威值**：`微信 / 支付宝 / 线下 / 无 / 储值卡`（共 5 值）
- **payNotify 使用**：
  - `payNotify/index.js:104-105`：`paymentMethod = paymentMethodInput || (order.payment_method === '支付宝' ? '支付宝' : '微信')`
  - 接受 event 入参 paymentMethod 任意值，无白名单校验
- **风险**：调用方可传 `'线下'` / `'储值卡'` / `'无'`（5 值任意）→ INSERT payments + UPDATE sale_orders.payment_method 全部接受。命中 P0-04-02。
- **建议**：(L3) 真实接入后从微信解密结果取 trade_type 映射（仅 '微信' / '支付宝'），event 入参 paymentMethod 在生产环境屏蔽

### E04-payment-change-type（payNotify 仅写 '首次支付' / '回款'）
- **枚举名**：`paymentChangeTypeEnum`
- **payNotify 使用**：
  - 普通销售单：事务内 SELECT 决定 '首次支付' / '回款'（`index.js:150-156`，比 staffApi 的事务外读模式更安全）
  - 凭证单：强制 '回款'（`index.js:147-148`）
  - 不写 '退款' / '储值卡抵扣'
- **风险**：与域 03 P0-03-02 互补 — payNotify 也未写 '储值卡抵扣'，依赖 sale_orders.prepaid_card_amount 列直推。invariant 三端漂移（详见 [E03-payment-change-type](#e03-payment-change-type)）
- **建议**：与域 03 修复同步推进

### E04-payment-flow-status（payNotify 仅写 '已支付'）
- **枚举名**：`paymentFlowStatusEnum`
- **payNotify 使用**：硬编码 `status = '已支付'`（`index.js:165`）
- **风险**：与域 03 一致，'已退款' 整枚举值零使用（详见 [E03-payment-flow-status](#e03-payment-flow-status)）

### E04-order-status（payNotify 状态机分支）
- **枚举名**：`orderStatusEnum`
- **payNotify 状态迁移**：
  - 入口接受集：`'已支付' / '已完成'` → 短路；`'待支付' / '部分支付'` → 处理；其他 → FAIL
  - 出口写入集：`'已支付' / '部分支付'`（凭证单强制 '已支付'）
- **风险**：与域 02 命中点互补，无新差异。命中 [P1-04-09]（凭证单 UPDATE 缺 CAS）

---

## 待补充

后续轮次发现的枚举不一致会追加到此文件。每个条目格式：

```
### E{NN}-{slug}
- **枚举名**：xxxEnum
- **权威值**：[a, b, c]
- **三端使用差异**：admin 用 [a,b,c]，staff 用 [a,b]，client 用 [a,b,c]
- **风险**：staff 漏处理 c → 数据落空 / UI 不显示
- **建议**：staff 补 c 处理逻辑 / 或将 c 标记为 admin-only
```

---

## 来自域 05（服务单 + 扣次原子性）

### E05-service-order-status
- **枚举名**：`serviceOrderStatusEnum`（`db/schema/enums.ts:66`）
- **权威值**：`待服务 / 服务中 / 已完成 / 已取消`（共 4 值）
- **三端使用差异**：
  - admin `cancelServiceOrder` 仅允许：`待服务` → `已取消`
  - staff `cancel` 允许：`待服务 / 服务中` → `已取消`
  - admin `startServiceOrder`：`待服务` → `服务中`（CAS）
  - staff `start`：同上但无幂等分支（重复点击报错）
  - client list/detail **未对状态做任何过滤**，已取消单也对顾客可见
- **风险**：admin/staff 状态机分歧（cancel 范围不一致）；client 看到无意义"已取消"记录
- **建议**：staff cancel 收敛到仅 '待服务'，对齐 admin；client list/detail 加 `status IN ('待服务','服务中','已完成')` 过滤
- **关联**：P0-05-04, P1-05-13

### E05-service-order-type
- **枚举名**：`serviceOrderTypeEnum`（`db/schema/enums.ts:68`）
- **权威值**：`售前 / 售后`（共 2 值）
- **三端使用差异**：
  - admin `createServiceOrder`（services.ts:466-467）：`became_member_at && became_member_at <= NOW() ? '售后' : '售前'`
  - staff `create`（service.js:155-164）：相同逻辑
  - client 不写
- **风险**：两端口径一致但**状态判定时机**不同——admin 用 `customerRow?.becameMemberAt && customerRow.becameMemberAt <= new Date()`（JS Date 比较），staff 用 SQL 拉值后 `new Date(cuRows[0].became_member_at) <= new Date()`（同样 JS Date 比较）。时区一致但若 `became_member_at` 用 PG TIMESTAMPTZ 存储 UTC，两端皆 OK；若有跨时区客户跨午夜成为会员，可能出现"刚成为会员的瞬间"售前/售后判定边界
- **建议**：抽到 `db/helpers/customer-classify.ts` 一处判定；或直接 PG 端 `WHERE became_member_at <= NOW()` 减一次往返
- **关联**：—（未升级 P 级，记为待优化）

## 来自域 06（预约 + 签到 → 服务单流转）

### E06-appointment-status
- **枚举名**：`appointmentStatusEnum`（`db/schema/enums.ts:70`）
- **权威值**：`待确认 / 已确认 / 已完成 / 已取消 / 已关闭`（共 5 值）
- **三端使用差异**：
  - **写入端 (status='待确认')**：仅 client.create
  - **写入端 (status='已确认')**：admin confirm（CAS）/ staff confirm（CAS + 写 confirmed_at）
  - **写入端 (status='已完成')**：仅 staff service.complete 在 so.appointment_id 非空时反推；admin completeServiceOrder **不写**（漏，跨端不一致）
  - **写入端 (status='已取消')**：admin cancel（CAS, 状态机宽 待确认/已确认）/ client cancel（**无 CAS**, P0-06-02）；staff 端**无 cancel handler**
  - **写入端 (status='已关闭')**：仅 staff service.complete 在次数归零时把同 sale_item 活跃预约置已关闭。**无任何过期定时任务实现 spec 规定的"超期 → 已关闭"分支**（P0-06-04）
  - **状态映射**：`staffApi/routes/appointment.js:29-39` 中文 → 英文 (`pending/confirmed/completed/cancelled/closed`) 给前端，client / admin 直接用中文枚举
- **风险**：
  1. '已完成' 写入路径 admin/staff 分裂：admin 完单后预约卡在 '已确认' 永远不变 '已完成'
  2. '已关闭' 实质只覆盖了"次数归零"语义；spec §5.3 规定的"超期"分支零实现 → 死预约永久占活跃锁位
  3. staff 端无原生 cancel handler，店长想取消必须靠 admin
  4. 中英映射仅 staff 一端做，admin/client UI 文案与 staff 不一致
- **建议**：
  - admin completeServiceOrder 同步 `UPDATE appointments SET status='已完成' WHERE appointment_id=$ AND status='已确认'`
  - 新增 cron STEP 关闭超期（SCHEMA-CHANGES S06-5）
  - 新增 staff.appointment.cancel handler 或在 spec 中明确 staff 不允许取消
  - 中英映射常量抽到 `db/helpers/enum-i18n.ts`
- **关联**：P0-06-04 / P1-06-11 / P1-06-13

### E06-appointment-status（重复签到 vs CAS）—— 检验维度
- 用例：staff.checkin 接受 `['待确认','已确认']`（line 246），admin.checkin 仅接受 `['已确认']`（line 228）
- 影响：跨端"checkin 前置状态"不对齐，spec §5.3 隐含 confirm 是 checkin 前置但代码两端分裂
- 关联：P1-06-11

---

### E05-allocation-status（在服务单上下文）
- **枚举名**：`allocationStatusEnum`（`db/schema/enums.ts:18`）权威值：`待分配 / 已分配`
- **三端使用差异**：
  - staff `complete`：写入 `commission_status = '已分配'`（service.js:454）—— 即使 rate=0 写空提成行也强行置已分配
  - admin `completeServiceOrder`：**完全不动** commission_status（services.ts:359-380）→ admin 路径下 commission_status 永远 NULL
  - cancel 路径（两端）：未将 commission_status 置 null/'已取消' 等终态
- **风险**：admin 完成的服务单 commission_status NULL，staff 完成的为 '已分配'，员工绩效报表口径混乱；rate=0 也写 '已分配' 让运维无法识别"待重算"
- **建议**：引入 '待分配 / 已分配 / 已作废 / 待重算'（拓展枚举）或新增 service_orders.commission_recalc_status 列；admin path 必须写 commission_status
- **关联**：P0-05-05, P0-05-06

---

## 来自域 07（销售提成分配）

### E07-allocation-status（订单维度）
- **枚举名**：`allocationStatusEnum`（`db/schema/enums.ts:18`）权威值：`待分配 / 已分配`
- **三端使用差异**：
  - admin batchSaveAllocations：同事务 SET '已分配'（allocations.ts:300）；空数组也 SET '已分配' (本意"无需分配"，与 staff 一致)
  - staff allocation.save：同事务 SET '已分配'（allocation.js:91, 188）；空数组同样 '已分配'
  - staff allocation.deleteAllocation：reset 回 '待分配'（allocation.js:239）
  - **payNotify 自动写 sa：从不修改 allocation_status**（index.js:330-355）→ pendingList 永久污染
  - 退款审批：refund 单本身 set '待分配'（order.js:1531 / refunds.ts:837），但**原销售单 allocation_status 不动**
- **风险**：
  1. payNotify 自动 100% 分配的订单永远卡在 pendingList，店长再分配时静默覆盖
  2. 空数组 '已分配' 与正常分配 '已分配' 在 SQL 层无法区分（语义"无需分配"丢失）
- **建议**：扩枚举为 `待分配 / 已分配 / 无需分配 / 自动分配`；至少 payNotify INSERT 完置 '已分配' 或新值 '自动分配'
- **关联**：P0-07-04

### E07-sales-category（一致性较好）
- **枚举名**：`salesCategoryEnum`（`db/schema/enums.ts:79`）权威值：`自销自耗 / 他销自耗 / 他销他耗 / 生态合作`
- **三端用法**：
  - sale_items.sales_category 列存（开单时写）
  - commission_rate_matrix.sales_category（VARCHAR(20) 而非 enum，schema commission.ts:19）→ 类型不一致风险
  - staff allocation.suggest 默认 '自销自耗'（allocation.js:446）
  - admin findMatchingRate 用 string match
- **风险**：commission_rate_matrix.sales_category 是 varchar(20) 不是枚举，未来加值时不能跨表 enforce
- **建议**：commission_rate_matrix.sales_category / order_type / role_type 三列由 varchar 转为对应 enum；ALTER TABLE … TYPE ... USING column::enum 一次性迁移
- **关联**：P1-07-09 (rate=0 静默)；非 P0

---

## 来自域 08（服务提成 service_commissions）

### E08-service-commission-status（commission_status 共用枚举的语义不足）
- **枚举名**：`allocationStatusEnum`（`db/schema/enums.ts:18`）权威值：`待分配 / 已分配`
- **当前共用范围**：
  - sale_orders.allocation_status（销售提成）
  - service_orders.commission_status（服务提成，schema service.ts:38）
- **三端使用差异**（服务提成视角）：
  - staff service.complete 永远写 '已分配'（service.js:454），即使 rate=0 静默写入
  - admin batchSaveServiceCommissions 写 `commissions.length > 0 ? '已分配' : '待分配'`（service-commissions.ts:166）
  - admin completeServiceOrder **完全不写**（services.ts:333-396）→ commission_status 保留 NULL
- **风险**：
  1. NULL（admin path）/ '待分配'（admin batchSave 空数组）/ '已分配'（含 rate=0 静默） 三种状态在 SQL 上无法区分语义
  2. UI 文案 admin allocations-page.tsx:171 用 '待分配' 兜底 NULL → 已分配的 admin 完成单显示"分配"按钮（语义反向）
  3. 缺"待重算"语义：rate=0 已写入但矩阵后补完 → 无法标记需要回扫
- **建议**：拆出独立 `serviceCommissionStatusEnum('待分配','已分配','部分分配','待重算')`；三端写入路径同步；admin completeServiceOrder 必须写值
- **关联**：P1-08-09, P0-08-02, P0-08-03

### E08-role-type（roleType 推断三端分裂，非枚举但需引入）
- **当前实现**：`db/schema/service-commission.ts:27` `roleType: varchar('role_type', { length: 20 }).notNull()`（migration 0016 改为 NOT NULL）；非 enum
- **三端推断算法**：
  - **staff service.complete** (`service.js:395-396`)：`skills[0] || '美容师'`（永远只取数组第一个）
  - **admin service-commission-detail-page.tsx:88-95**：`if (skills.includes('推广师')) → '推广师'; else if (skills.includes('养生师')) → '养生师'; else → '美容师'`（**优先级反过来**）
  - **payNotify** (`payNotify/index.js:336-337`)：`skills[0] || '美容师'`（与 staff 一致，与 admin 不一致）
- **风险**：员工 skills=['美容师','推广师'] 时三端写入 / 显示 / 重算结果不同；commission_rate_matrix 按 role_type 维度查询时命中行不同 → 提成金额漂移
- **建议**：
  1. 引入 `roleTypeEnum('美容师','养生师','推广师')`，对 service_commissions / sale_allocations / commission_rate_matrix 三表 role_type 列统一类型
  2. 抽 `db/helpers/role-resolve.ts`：`resolvePrimaryRole(skills: string[]): RoleType` 由业务确认优先级（推荐 `推广师 > 养生师 > 美容师`，因为推广师角色最稀有）
  3. payNotify / staff.complete / admin batchSave / admin UI init 五处统一调用
- **关联**：P0-08-06, P1-07-06（销售提成同源）

## 来自域 09（商品 + SKU + 价格 + 有效期）

### E09-product-type
- **枚举名**：`productTypeEnum`（`db/schema/enums.ts:3`）
- **权威值**：`疗程卡 / 单品 / 家居产品`（共 3 值）
- **三端使用**：
  - admin `actions/products.ts:530`：`VALID_PRODUCT_TYPES = ['疗程卡','单品','家居产品']` **硬编码白名单**（与 PG enum 重复定义；enum 改值后应用层不会同步）
  - staff `routes/product.js`：跟随 PG enum，shopInit / skuList / skuDetail 直接 SELECT 字段
  - client `routes/product.js`：跟随 PG enum
  - 衍生表：`sale_items.product_type`（同 enum 类型）/ `service_items.product_type`（同 enum 类型，开单时快照）
- **风险**：
  1. admin 硬编码 vs PG enum 双源不同步（CC9 残留模式）
  2. productType 值域与 productKind（动态文本）有重叠（"家居产品"同时是 productType 和 productKind 候选值）→ schema 层无 CHECK 保证一致
- **建议**：
  1. admin VALID_PRODUCT_TYPES 改从 `productTypeEnum.enumValues` 导入
  2. 评估给 product_skus 加 CHECK：`(productKind='充值卡' AND productType='单品') OR (productKind='体验卡' AND productType='单品') OR (productKind='家居产品' AND productType='家居产品') OR ...`
- **关联**：P1-09-05, P2-09-13

### E09-product-kind（动态文本，非 PG enum）
- **当前实现**：`db/schema/product.ts:21` `productCategories.productKind: text('product_kind')`（自由文本，DB 驱动）
- **业务权威值**：PLAN §2 行 71 列 4 值（护理项目 / 家居产品 / 充值卡 / 体验卡）；2026-04-10 baseline reset 时去除"组合套餐"（改用 products.is_bundle）+ "福利活动"（合并到护理项目）
- **三端使用差异**：
  - admin：完全 DB 驱动；`getProductsByKind(kind: string | '__bundle__' | '__normal__')` 接受任意字符串
  - staff `routes/product.js:29`：`CARD_PRODUCT_KINDS = ['充值卡', '体验卡']` **硬编码兜底**（注释 PR-D 起改用 DB `is_card_kind=true` 作 SSoT，但仍保留硬编码 fallback）
  - client：完全 DB 驱动（仅通过 product_categories JOIN 取 productKind 字段）
  - 前端 staff 小程序 `pages/order-create/order-create.ts`：硬编码字面量分支（按 PLAN 提到，未在本审计扫描）
- **风险**：
  1. 运营在 admin 新建 productKind=`微整美容` 后，staff 小程序按硬编码分支不识别 → 新 kind 不出现在卡类 / 普通商品分组
  2. CARD_PRODUCT_KINDS 兜底常量与 `product.cardKinds` action（DB 查询）双源不同步，admin 把 isCardKind=false 改 true 后 staff 端可能仍不识别（取决于 cardKinds() 是否被首先调用）
- **建议**：
  1. staff CARD_PRODUCT_KINDS 改注释强调"仅 DB 查询失败时使用"，正常路径必须先调 `product.cardKinds`
  2. 前端硬编码字面量分支审计（专题待 P2 域 24 品项分类动态字段）
- **关联**：P1-09-10

### E09-product-kind-vs-product-type（隐性约束缺失）
- **现象**：productKind（business 业务大类）与 productType（机制）值域有重叠："家居产品" 在两个值域同时出现，但 schema 无 CHECK 强制对应关系
- **建议**：在 `.42cog/cog.md` 或 backend.pr.spec.md 显式定义对应矩阵：
  | productKind | 允许 productType |
  |-------------|-----------------|
  | 护理项目 | 疗程卡, 单品 |
  | 家居产品 | 家居产品 |
  | 充值卡 | 单品 |
  | 体验卡 | 单品 |
- **关联**：P1-09-05

### E08-commission-rate-matrix-order_type（隐性枚举）
- **当前实现**：`db/schema/commission.ts:17` `orderType: varchar('order_type', { length: 20 }).notNull()`，权威值有 `'销售单' / '服务单' / '转换单'` 三种（隐性约定）
- **三端使用**：
  - admin commission-page.tsx:26：硬编码 `ORDER_TYPE_OPTIONS = ['销售单', '服务单']`（缺转换单）
  - staff service.complete：`WHERE order_type = '服务单'`（service.js:403）
  - staff allocation.suggest：按 sale_order_type → matrix order_type 直接 match
- **风险**：admin 可创建 `order_type='服务单'` 但矩阵 staff 端查询用同字面量；如果 admin 误填 'service' 等英文，schema 不会拒绝
- **建议**：与 S08-5 一起改 enum；同步 audit-07 ENUM E07-sales-category
- **关联**：P2-08-16

---

## 来自域 10（顾客 + 会员等级）

### E10-monthly-activity
- **枚举名**：`monthlyActivityEnum`（`db/schema/enums.ts:114`）
- **权威值**：`二次客活 / 一次客活 / 0次客活`（3 值）
- **现状**：admin filter 支持（`actions/customers.ts:195-197`），但 cron 6 STEP 无任何写入 → 全行为 NULL（P0-10-05）
- **建议**：保留则同步加 cron STEP；废弃则连 enum + 列 + filter 一起 DROP

### E10-spending-tier
- **枚举名**：`spendingTierEnum`（`db/schema/enums.ts:112`）
- **权威值**：`10W+ / 6-10W / 3-6W / 1-3W / 1990-1W / <1990`（6 值）
- **问题**："1990-1W" 标签含具体阈值字面量，但实际下界由 `system_configs.new_member_threshold` 配置（默认 1980 而非 1990）。配置改 2000 时标签与边界漂移
- **建议**：枚举改为语义化 bucket（`tier-1` … `tier-6`）+ admin/UI 层 join 配置展示文案
- **关联**：P1-10-14

### E10-member-level
- **枚举名**：`memberLevelEnum`（`db/schema/enums.ts:93`）
- **权威值**：`初钻 / 星钻 / 粉钻 / 金钻 / 黑钻`（5 值）
- **三端使用一致**：admin filter 全 5 值 + cron `determineMemberLevel`（`fengyu-admin/src/cron/lib/member-level.ts:25`）+ staff/client 仅展示
- **跃迁阈值**：黑钻 ≥ 100000、金钻 ≥ 60000、粉钻 ≥ 30000、星钻 ≥ 10000、初钻 ≥ system_configs.new_member_threshold
- **保级期**：升级时 `member_level_locked_until = NOW() + INTERVAL '150 days'`，降级路径在保级期内跳过（`refresh-member-levels.ts:181-194`）
- **风险**：重算口径 paid_amount/12月 与 spending_tier 用 total_amount 累计 → 同顾客双指标漂移（P0-10-06）
- **建议**：见 S10-2

### E10-customer-type
- **枚举名**：`customerTypeEnum`（`db/schema/enums.ts:108`）
- **权威值**：`流量客 / 体验客 / 小美客 / 会员客`（4 值）
- **跃迁规则**：单调递增（`流量客 < 体验客 < 小美客 < 会员客`），由 EXISTS 子查询判定，UPDATE 用 CASE 序数比较确保只升不降
- **写入路径**：staffApi/routes/order.js:73-156 + payNotify/index.js:358-463（100% 重复 SQL），admin updateCustomer 不触发
- **建议**：抽单源（S10-3）

### E10-customer-status
- **枚举名**：`customerStatusEnum`（`db/schema/enums.ts:116-122`）
- **权威值**：`保有会员-稳定 / 保有会员-有效 / 沉睡 / 冰冻 / 休眠`（5 值）
- **写入路径**：仅 cron STEP 1 `refresh-customer-status.ts`（仅会员客有值，非会员客一律 NULL）
- **业务一致**：admin filter 通过 enum；mgmt-traffic.js:531 `customer_type IN ('体验客', '小美客')` 与本枚举无关。✓

### E10-customer-source
- **枚举名**：`customerSourceEnum`（`db/schema/enums.ts:95-106`）
- **权威值**：`美团 / 抖音 / 小程序 / 推带新 / 地推卡 / 拓客卡 / 老带新 / 转让店 / 自进店 / 内部员工或家属`（10 值）
- **问题**：硬枚举包含具象渠道，新渠道（小红书/视频号）扩展需 schema migration
- **建议**：改软枚举（system_configs 维护下拉值）或显式扩展约定
- **关联**：P2-10-16

---

## 来自域 11（退款 / 退换货）

### E11-order-status（缺 '已驳回' 与 '已关闭' 复用）
- **枚举名**：`orderStatusEnum`（`db/schema/enums.ts:5-14`）
- **权威值**：`待支付 / 待确认收款 / 已支付 / 已完成 / 支付失败 / 已关闭 / 待审批 / 部分支付`（共 8 值）
- **退款流使用**：
  - 创建：`'待审批'`（FY-TKD 入库时强制）
  - 审批通过：`'已支付'`（与销售单成功支付共用同枚举值，仅靠 sale_order_type 区分语义）
  - 审批驳回：`'已关闭'` + `rejected_reason`（与 close 超时关闭 / cancel 取消同值）
- **风险**：
  - 列表筛选 `'已关闭'` 无法区分 "退款驳回 / 订单超时关 / 订单取消"，只能 LEFT JOIN `rejected_reason IS NOT NULL` 推断
  - admin refunds 列表筛选选项 `['待审批', '已支付', '已关闭']` 暴露 '已关闭' 文案=驳回，UI 文案与状态枚举耦合脆弱
- **建议**：扩枚举 `'已驳回'`（独立审批语义）；rejectRefund 写新值；列表 UI 同步 — 详见 [S11-1](./SCHEMA-CHANGES.md#s11-1-orderstatusenum-增加-已驳回独立审批语义)
- **关联**：[P0-11-07](./audit-11-refunds.md#p0-11-07)

### E11-payment-flow-status（'已退款' 仍 0 使用）
- **枚举名**：`paymentFlowStatusEnum`（`db/schema/enums.ts:49-54`）
- **权威值**：`待支付 / 已支付 / 已作废 / 已退款`（共 4 值）
- **本域使用**：
  - 退款 payments 创建：`'待支付'`（待审批的退款行）
  - 退款 approve：翻 `'待支付'` → `'已支付'`
  - 退款 reject：翻 `'待支付'` → `'已作废'`
  - **'已退款' 仍 0 引用**（与 audit-03 / 04 一致）
- **建议**：与 audit-03 E03-payment-flow-status 同诉求合并 — 业务确认是否启用，否则 DROP

### E11-payment-method（resolveRefundPaymentMethod '微信/支付宝' → '线下' 过渡映射）
- **枚举名**：`paymentMethodEnum`（`db/schema/enums.ts:22`）
- **权威值**：`微信 / 支付宝 / 线下 / 无 / 储值卡`（共 5 值）
- **退款映射**：staff `utils/refund.js:126-134` + admin `lib/refund.ts` 把原单 '微信'/'支付宝' 通道的退款行 payment_method 强制改写为 '线下'，承接"微信 V3 退款 API 未集成"过渡期
- **风险**：业务上"原路退回"完全靠人工现金；与微信小程序行业规范不符；TODO 漂移（注释自 ticket 2026-04-24 起未推进）
- **建议**：单独 ticket 集成微信 V3 退款 API，移除映射 — 详见 [P2-11-16](./audit-11-refunds.md#p2-11-16)
- **关联**：[P2-11-16](./audit-11-refunds.md)

### E11-sale-order-type（'转换单' 与 '退款单' 都进 customer.refundHistory）
- **枚举名**：`saleOrderTypeEnum`（`db/schema/enums.ts:16`）
- **权威值**：`销售单 / 内部单 / 回款单 / 转换单 / 退款单`（共 5 值）
- **本域使用**：staff `routes/customer.js:697` `o.sale_order_type IN ('退款单', '转换单')`
  - "退换记录" 路由把转换单与退款单合并展示 — 业务上转换单是"另选 SKU 替换"（非真退款），财务语义不同
- **风险**：报表口径混乱：UI 文案"退换记录"暗示纯退款，但实际含转换单（顾客可能并未拿回钱）。无 P 级风险，仅文案歧义。
- **建议**：UI 列表行内增 `type` Tag 区分；或拆 client.refundHistory 与 client.conversionHistory 两路由
- **关联**：—（P2 级，记入待优化）

---

## 来自域 12（门店绑定 / 解绑流）

### E12-store-unbind-request-status（4 值全用，admin/staff/client 用法对齐）
- **枚举名**：`storeUnbindRequestStatusEnum`（`db/schema/enums.ts:72-77`）
- **权威值**：`待处理 / 已通过 / 已拒绝 / 已取消`（共 4 值）
- **三端使用**：
  - client `requestUnbind` 写 `'待处理'`；`cancelUnbindRequest` 翻 `'待处理'` → `'已取消'`
  - staff `approveUnbind` 翻 `'待处理'` → `'已通过'`；`rejectUnbind` 翻 `'待处理'` → `'已拒绝'`
  - admin `approveUnbind` / `rejectUnbind` 同 staff
- **集合一致性**：枚举 4 值在三端全部覆盖，状态机闭合（无废弃值，无遗漏值）
- **缺陷**：仅是状态值名称没问题；问题在状态机推进**完全无 CAS 守卫**，并发可破坏单向性（详见 audit-12 P0-12-04 + CC2 跨域归集）
- **关联**：—（无枚举级问题，记一笔状态完整性✅）

### E12-payment-method 解绑无相关使用
- 本域不写款项流水，无 paymentMethod 相关枚举使用，跳过

---

## 来自域 13（优惠券）

### E13-coupon-type（3 值全用，三端字面量直接比较）
- **枚举名**：`couponTypeEnum`（`db/schema/enums.ts:81`）
- **权威值**：`现金券 / 品项券 / 折扣券`（共 3 值）
- **三端使用**：
  - admin `actions/coupons.ts:282` `VALID_COUPON_TYPES = ['现金券', '品项券', '折扣券']` 入参白名单 ✅
  - admin `lib/utils.ts:44 calcCouponDiscount` 用 `couponType === '折扣券'` 分支
  - admin `lib/types.ts:200` `CouponType = '现金券' | '品项券' | '折扣券'` 联合类型 ✅
  - staff `routes/coupon.js:116-118` + `routes/order.js:381-388` 字面量比较
  - client `routes/coupon.js:203-209` + `routes/order.js:303-309` 字面量比较
- **集合一致性**：3 值三端全覆盖，无废弃值，无遗漏值 ✅
- **缺陷**：—（枚举本身无问题；问题在折扣计算逻辑跨端重复 P2-13-16）
- **关联**：—

### E13-coupon-status（3 值，状态机有缺：缺"作废"语义）
- **枚举名**：`couponStatusEnum`（`db/schema/enums.ts:83`）
- **权威值**：`未使用 / 已使用 / 已过期`（共 3 值）
- **三端使用**：
  - 三端 order.create CAS UPDATE: `'未使用' → '已使用'`
  - 三端 order close/cancel: `'已使用' → '未使用'`（释放）
  - 三端 lazy expire: `'未使用' → '已过期'`（WHERE expire_at <= NOW()）
- **集合一致性**：3 值三端全覆盖 ✅
- **状态机缺陷**：
  - 缺 **'已作废'** 状态（admin 停用模板时不能直接置已发券为某中间状态，只能依赖 client list 不过滤 is_active 这个 bug → 已发未用券依赖 lazy expire 等到 expire_at 才消失，UX 断裂 P1-13-15）
  - 缺 **'冻结'** 中间态（如风控审核期间应能临时不可用）
  - "退款释放"路径完全缺失（P0-13-04）：退款审批应执行 `'已使用' → '未使用'`，但 admin/staff approveRefund 完全无此 UPDATE
- **建议**：
  - 短期：补全释放路径（P0-13-04）+ admin toggleTemplateActive 同步置已发未用为 `'已过期'`（S13-5 方案 B）
  - 长期：考虑增加 `'已作废'` 第 4 值，覆盖运营手动作废、风控冻结等场景
- **关联**：[P0-13-04](./audit-13-coupons.md#p0-13-04) + [P1-13-15](./audit-13-coupons.md#p1-13-15)

### E13-validity-mode（非 PG enum，是 text 列 + 应用层校验）
- **字段**：`coupon_templates.validity_mode text default 'fixed'`（`db/schema/coupon.ts:32`）
- **应用层值**：`'fixed' | 'days'`（admin `actions/coupons.ts:271` 联合类型）
- **缺陷**：未声明为 PG enum，schema 仅 `text` + `default 'fixed'`；admin `validateValidityFields:28` 应用层校验：`if (merged.validityMode !== 'days' && merged.validityMode !== 'fixed') return false`。脏数据可绕过（如直接 SQL 写入 `'forever'`），cron 计算 expireAt 兜底走 `else { expireAt = NOW() + 365d }` 的隐式 default
- **建议**：迁移为 PG enum `coupon_validity_mode_enum ['fixed', 'days']`，schema 强约束
- **关联**：—（P2 级，未在 audit-13 P0/P1 列出，记入此处）

---

## E14 充值卡 + 卡流水（audit-14）

### E14-card-transaction-type
- **来源**：`db/schema/enums.ts:89`
- **声明**：`cardTransactionTypeEnum = pgEnum('card_transaction_type', ['充值', '扣款'])`
- **三端使用**：
  - admin `actions/card-transactions.ts:64-66` 精确匹配
  - staff `routes/order.js` 多处 `'充值'` / `'扣款'` 字符串字面量
  - client `routes/order.js` / `routes/card.js` 同上
  - payNotify `index.js:284 / :320` 同上
- **检查**：✅ 三端字符串字面量使用与枚举值一致；admin summary 用 `amount` 符号判断而非 `type` 字段（`actions/card-transactions.ts:154-156`），刻意规避脏数据漂移
- **风险**：枚举值少且稳定；但 amount 缺 sign CHECK 让"按符号汇总" vs "按 type 过滤"在脏数据下可能不一致 → S14-02 解决

### E14-payment-change-type-储值卡抵扣（关联）
- **来源**：`db/schema/enums.ts`（payment_change_type 枚举含 `'储值卡抵扣'`）
- **检查**：admin `actions/orders.ts:426-487 confirmOfflinePayment` 完全不写 `'储值卡抵扣'` payments 行；client `routes/order.js:503-523 / :1416-1446` 同样不写。staff confirmOffline / createRepayment / approveRefund 完整写入。
- **三端漂移**：与本域 P1-14-06 / P1-14-07 关联（retain audit-03 P0-03-02）
- **关联**：[audit-03 P0-03-02](./audit-03-payment-flow.md) + [P1-14-06](./audit-14-prepaid-card.md#p1-14-06)

---

## 来自域 15（积分 + 等级跳档）

### E15-point-transaction-type（自由文本字段，应升级为 PG enum）
- **字段**：`point_transactions.type text NOT NULL DEFAULT '获取'`（`db/schema/points.ts:18`）
- **应用层值**（5 处散写）：
  - `staffApi/utils/points.js:80` + `clientApi/utils/points.js:70` + `payNotify/points.js:58` — `'消费赠送' / '消费冲销'`
  - `cron/steps/refresh-member-levels.ts:252` — `'等级升级奖励'`
  - `cron/steps/grant-birthday-benefits.ts:126` — `'生日积分'`
  - `cron/steps/grant-thanksgiving-benefits.ts:142` — `'感恩回馈'`
  - admin `actions/points.ts:14-18` 注释列出 3 种 + distinctTypes 动态读出
- **缺陷**：未声明为 PG enum，schema 仅 `text default '获取'`（注意 default '获取' 也是脏值，与所有写入路径不符）；任意自由文本可写入 → 类型字段失去枚举语义；多端副本随时漂移。
- **建议**：迁移为 PG enum `point_transaction_type ENUM ('消费赠送','消费冲销','等级升级奖励','生日积分','感恩回馈','手动调整')`，schema 强约束（详见 [SCHEMA-CHANGES S15-04](./SCHEMA-CHANGES.md#s15-04-point_transactionstype-升级为-pg-enum)）
- **关联**：[P0-15-02](./audit-15-points-member-level.md#p0-15-02) / [P1-15-12](./audit-15-points-member-level.md#p1-15-12)

### E15-member-level-coverage（已是 PG enum，使用面验证）
- **来源**：`db/schema/enums.ts:93` — `memberLevelEnum = pgEnum('member_level', ['初钻','星钻','粉钻','金钻','黑钻'])`
- **三端使用**：
  - admin `cron/lib/member-level.ts:14 MemberLevel` typeof enumValues ✅
  - admin `actions/points.ts:140` 列表展示 ✅
  - admin UI `_components/points-page.tsx:21-27` 5 值彩色 badge ✅
  - cron determineMemberLevel 5 值映射 ✅
  - schema `client_wechat_users.member_level` + `old_member_level` ✅
- **检查**：✅ 三端使用一致；未发现枚举漂移
- **风险**：`grant-birthday-benefits.ts:51` 与 `refresh-member-levels.ts:50` 都把 `member_level IS NOT NULL` 当作"会员资格"判定；与 `customer_type='会员客'` 形成 **双重资格判定**，是双口径漂移的隐式根源（[P0-15-04](./audit-15-points-member-level.md#p0-15-04)）。建议在 .42cog/cog.md 显式声明"member_level 仅会员客可有"或"member_level 与 customer_type 解耦"。
- **关联**：[P0-15-04](./audit-15-points-member-level.md#p0-15-04) / [P1-15-14](./audit-15-points-member-level.md#p1-15-14)

## 来自域 16（消息中心）

### E16-message-recipient-type
- **枚举名**：`messageRecipientTypeEnum`（`db/schema/enums.ts:87`）
- **权威值**：`客户 / 员工`（共 2 值）
- **三端使用现状**：
  - admin `actions/messages.ts:391` 显式注释 "消息仅允许 recipient_type='客户'（员工消息暂不支持批量发送）"；getMessagesPaginated 可读两值（`:64-65`）
  - admin `mergeClientProfile` 仅 UPDATE recipient_type='客户' 行（`actions/customers.ts:838`）
  - cron-worker STEP 2/3/4 全部 INSERT '客户'
  - share-gift 三副本全部 INSERT '客户'（`fengyu-staff/staffApi/share-gift.js:133` / `fengyu-client/clientApi/share-gift.js:133` / `fengyu-client/payNotify/share-gift.js:133`）
  - staffApi `routes/` 完全无 message route（0 list/read/unreadCount）
  - **'员工' 值 0 写入 0 读取**
- **检查**：⚠️ 孤儿枚举值（半实现状态）
- **风险**：spec 与代码脱节；将来若有人误调 admin 自定 SQL 写入 '员工' 行，员工无前端入口可读取（数据黑洞）
- **建议**：（决策性）方案 A 补 staffApi message route 激活枚举；方案 B 从 enum 删除 '员工'（先验证 0 行存量，不可逆）。详见 [S16-4](./SCHEMA-CHANGES.md#s16-4-messagerecipienttypeenum-决策保留-vs-删除员工)
- **关联**：[P0-16-04](./audit-16-message-center.md#p0-16-04)

### E16-message-type（事实枚举）
- **字段**：`messages.message_type`（`varchar(50)`，无 PG ENUM 约束，自由文本）
- **三端使用现状**：
  - admin batchSend：用户输入任意 50 字内文本（`actions/messages.ts:407-410`）
  - cron-worker STEP 2/3/4：硬编码 `'system'`（`refresh-member-levels.ts:241` / `grant-birthday-benefits.ts:115` / `grant-thanksgiving-benefits.ts:131`）
  - share-gift（3 副本）：硬编码 `'system'`
  - client 渲染 TYPE_COLOR_MAP 仅识别 `appointment / order / system` 三值（`pagesProfile/messages/messages.ts:8-18`）
  - admin getMessageTypes 返回 DISTINCT 实际取值（`actions/messages.ts:156-168`）作为筛选下拉
- **检查**：⚠️ 全栈写值仅 'system'，但 client 已为 'appointment'/'order' 配色；产品规范 `client.pr.spec.md:292-294` 所列三类（预约提醒蓝/支付通知绿/优惠通知橙）"未实现"
- **风险**：admin batch 任意值（如 '促销' vs 'promotion'）会污染分类；client fallback 配色无法区分业务来源
- **建议**：定义 `messageTypeEnum`，详见 [S16-3](./SCHEMA-CHANGES.md#s16-3-messagetypeenum-收敛)
- **关联**：[P1-16-05](./audit-16-message-center.md#p1-16-05) / [P1-16-06](./audit-16-message-center.md#p1-16-06)

---

### E15-LEVEL_RANK 与 enum 顺序硬绑定
- **字段**：`fengyu-admin/src/cron/lib/member-level.ts:16-23`
- **现象**：`LEVEL_RANK = { null: 0, 初钻: 1, 星钻: 2, 粉钻: 3, 金钻: 4, 黑钻: 5 }` 是手写常量，未基于 `memberLevelEnum.enumValues` 自动生成
- **风险**：未来在枚举中部插入新值（如 "白钻"）会让 LEVEL_RANK 错位 → isUpgrade/isDowngrade 失真
- **建议**：改为 `LEVEL_RANK = memberLevelEnum.enumValues.reduce((m, v, i) => ({ ...m, [v]: i+1 }), { null: 0 })`
- **关联**：[P2-15-16](./audit-15-points-member-level.md#p2-15-16)

---

## 来自域 17（数据看板）

### E17-sale-order-type-dashboard 入口三端口径
- **枚举名**：`saleOrderTypeEnum`（`db/schema/enums.ts:16`，5 值：销售单 / 内部单 / 回款单 / 转换单 / 退款单）
- **三端使用差异**：
  - admin `getDashboardStats` 全部 SUM SQL **不限 sale_order_type** → 5 值全混入营业额（业绩 / paid_amount / 客流）
  - mgmt-dashboard `summary` / `storeRanking` / `staffRanking` / `salesData` 显式 `sale_order_type IN ('销售单','转换单')`（与 metrics.md 对齐）
  - staff.dashboard 美容师分支走 sa.is_void 维度（间接受 audit-07 P0-07-02 退款不冲销影响）
- **风险**：admin 业务角色看板永久把退款单 paid_amount 算正向业绩（资损展示）
- **建议**：在 `db/schema/enums.ts:16` 注释中加 "**业绩聚合 SQL 应限定 sale_order_type IN ('销售单','转换单')**"；测试用 fixture 验证 5 类全建后 admin 业绩等于 mgmt summary
- **关联**：[P0-17-02](./audit-17-dashboard.md#p0-17-02)

### E17-customer-type-history（与 audit-10 P0-10-05 同根再确认）
- **枚举名**：`customerTypeEnum`（流量客 / 体验客 / 小美客 / 会员客）
- **现象**：mgmt-dashboard `salesData` 顾客分型 SQL（`mgmt-dashboard.js:1284-1357`）对"小美客"用 `c.customer_type = '小美客'`（当前快照），与"会员客"已切到 `c.became_member_at::date >= [period_start]`（历史化）形成混合口径；metrics.md `D-4=A` 已显式接受但建议 T2 落地后切换
- **风险**：跨期看板（看历史月份）顾客分型按"今天的快照"分组，去年消费的"流量客"如果今年升级"小美客"会被计入"小美客业绩"
- **建议**：长期方案——schema 加 `became_xiaomei_at` / `became_trial_at` 时间戳字段，与 `became_member_at` 对齐；短期——UI 角标提示
- **关联**：[P1-17-09](./audit-17-dashboard.md#p1-17-09) + [audit-10-customer-member-level.md P0-10-05](./audit-10-customer-member-level.md#p0-10-05)

---

## 来自域 18（员工绩效 performanceDetail）

### E18-employee-performance — `filterType` 是隐式枚举但无 schema/类型校验
- **枚举名**：API 层 "filterType"（值：`'sale'` / `'service'` / undefined）
- **现象**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:582-585` 仅 `if/else if` 取值，未定义白名单常量、未做 INVALID_PARAMS 抛出；前端 `staff-performance.ts:184-185` 由 Tab 索引硬编码映射成 'sale' / 'service'。任何拼写错误或恶意客户端可传 'sales' / 'SALE' / 任意字符串静默走"合并集"分支。
- **风险**：API 契约不明确；与 admin 端 Zod 校验风格脱节；后端无法在加新 filterType 时 grep 全仓使用方
- **建议**：在 `routes/staff.js` 头部定义常量 `const PERFORMANCE_FILTER_TYPES = ['sale', 'service']`，入参强制白名单校验抛 `INVALID_PARAMS:`；Tab 名 → filterType 的映射改为前后端共用常量
- **关联**：[P1-18-05](./audit-18-employee-performance.md#p1-18-05)

### E18-sales-category-tab — `salesCategory` 与 sa.sales_category 列绑定但 UI 仅暴露 4 选 2
- **枚举名**：`salesCategoryEnum`（`db/schema/enums.ts`：自销自耗 / 他销自耗 / 他销他耗 / 生态合作 4 值）
- **现象**：staff-performance UI 仅在 Tab 3/4 暴露 `'他销他耗'` / `'生态合作'` 两值（`staff-performance.ts:186-187`）；`'自销自耗'` / `'他销自耗'` Tab 不存在，等同于"合计"或"销售"Tab 内未拆分。后端 `salesCategory` 入参也无白名单，可传任意字符串。
- **风险**：员工无法独立查看"自销自耗" / "他销自耗"业绩；如未来枚举加新值（如"客转介"），前端 Tab 不会自动新增 → 数据隐藏。
- **建议**：UI Tab 改为按枚举值动态生成；后端入参强制 `IF (salesCategory && !SALES_CATEGORY_ENUM.includes(salesCategory)) throw INVALID_PARAMS`
- **关联**：[P1-18-05](./audit-18-employee-performance.md#p1-18-05)

### E18-sale-order-type-perf — performanceDetail 不限 sale_order_type，5 值全混入员工绩效
- **枚举名**：`saleOrderTypeEnum`（5 值：销售单 / 内部单 / 回款单 / 转换单 / 退款单，与 E17 同枚举不同入口）
- **三端使用差异**：
  - mgmt-dashboard 已限定 `sale_order_type IN ('销售单','转换单')`（见 E17 条）
  - staff `routes/staff.js:475-482 performanceDetail` / `:163-175 todayCommission` / `:259-273 monthlyCalendar` / `:660-686 dashboard` **全部不限**
  - admin 缺位（无员工绩效查询）
- **风险**：员工绩效汇总 sa 行包含退款单负行 / 内部单半价 / 回款重复行 → 与营业额看板（已限）不可对账，资损 + 数据失真。
- **建议**：与 E17 修复同步；员工 / 门店级 sa 汇总 SQL 都加 `sale_order_type IN ('销售单','回款单')` 或显式排除 '退款单','内部','转换单'，并提取 `assertSettlableOrderType()` 助手统一 WHERE 子句
- **关联**：[P0-18-01](./audit-18-employee-performance.md#p0-18-01) + [E17-sale-order-type-dashboard](#e17-sale-order-type-dashboard-入口三端口径)

## 来自域 20（家居产品提货）

### E20-item-direction-pickup-guard — `itemDirection` 4 值在 staff createPickup UPDATE WHERE 缺守卫
- **枚举名**：`itemDirectionEnum`（`db/schema/enums.ts:20`：购买 / 转出 / 转入 / 退出 4 值）
- **三端使用差异**：
  - admin `actions/pickup-records.ts:317` UPDATE WHERE 显式 `AND item_direction = '购买'` ✅
  - admin `actions/pickup-records.ts:254` available 查询 `AND si.item_direction = '购买'` ✅
  - **staff `routes/order.js:2392-2398` createPickup UPDATE WHERE 完全缺 item_direction 守卫** ❌
  - staff `order.js:1547-1558` approveRefund 已限 `item_direction = '退出'` ✅（仅扣减 remaining_sessions，未处理家居 picked_up）
  - staff `order.js:2197-2243` createConversion 仅在 outItems 路径处理 `item_direction = '购买'` 行（line 2070 显式 if）✅
- **风险**：staff createPickup 漏守卫 → "退出" / "转出" 行的 sale_items 也带 `quantity > 0`、`picked_up_quantity = 0`（默认），CAS 通过 → 退款 / 转换流程产生的方向行被错误地"提货"，四值的方向语义被破坏
- **建议**：同 E07 / E18 一并提取 `assertItemDirectionPurchase()` SQL helper；任何"对原购买行的库存 / 次数 / 提货数变更"语句强制走该 helper
- **关联**：[P0-20-02](./audit-20-pickup.md#p0-20-02) + [P1-20-04](./audit-20-pickup.md#p1-20-04)

### E20-product-type-pickup-rollback — `productType` 在 approveRefund 三端 100% 仅处理'疗程卡'，'家居产品'/'单品'分支缺位
- **枚举名**：`productTypeEnum`（`db/schema/enums.ts:3`：疗程卡 / 单品 / 家居产品 3 值）
- **三端使用差异**：
  - admin `actions/refunds.ts:847-872` approveRefund 仅 `if (ri.ref_sale_item_id && ri.session_count)` 分支扣减 remaining_sessions（隐式仅疗程卡）❌
  - staff `routes/order.js:1547-1558` approveRefund 同 ❌
  - admin `actions/refunds.ts:200` calculateUnusedQuantity 三类型分支都覆盖 ✅（仅校验阶段）
  - staff `utils/refund.js:19-27` 三类型分支都覆盖 ✅（仅校验阶段）
- **风险**：approveRefund 在两端都仅处理疗程卡，对 productType ∈ ('单品','家居产品') 完全不做 picked_up_quantity 累加（视实际 unused = 1.0，不足以兜底）→ 退款过审后顾客仍可继续提货 → 双消费资损（详见 P0-20-01）
- **建议**：approveRefund 应按 productType 分支：
  - 疗程卡 → CAS `remaining_sessions -= ri.quantity`
  - 单品 / 家居产品 → CAS `picked_up_quantity += ri.quantity`，WHERE `(quantity - COALESCE(picked_up_quantity,0)) >= ri.quantity`
- **关联**：[P0-20-01](./audit-20-pickup.md#p0-20-01)

---

## 来自域 21（组织架构）

无新条目。orgNodeType 4 值（总部/市场/门店/部门）在 admin / staff / client 三端处理一致，无漏值或废弃值残留。

---

## 来自域 22（权限矩阵 + 角色）

### E22-role-text-no-enum
- **字段名**：`permission_roles.role`
- **权威值**：TS 联合 7 值（admin/manager/finance/hr/product/customer_mgr/staff）
- **三端使用差异**：admin 用 PERMISSION_MATRIX 字典（hardcode），staff 用 staffLevel 派生 + 各路由硬编码 requireManager
- **风险**：DB 列是 text 无 enum，可写入任意字符串 → admin PERMISSION_MATRIX[role] 静默 undefined
- **建议**：新增 PG enum + 类型升级（见 [S22-1](./SCHEMA-CHANGES.md)）

### E22-positionScope-vs-orgNodeType
- **枚举名**：positionScopeEnum (3 值) vs orgNodeTypeEnum (4 值)
- **权威值**：3 值是总部/市场/门店，4 值多一个"部门"
- **三端使用差异**：permission_roles.scope_id FK 到 org_nodes 但没禁用 type='部门' 行
- **风险**：scope_id 指向"部门"导致 expandScopeStoreIds 返回空集，越权空查
- **建议**：见 [P0-22-01](./audit-22-permission-matrix.md) + [S22-2](./SCHEMA-CHANGES.md)

### E22-staff-role-ghost
- **字段名**：RoleType.staff
- **权威值**：admin PERMISSION_MATRIX[staff]=[]；staff 端 staffLevel=LEVEL_STORE_STAFF 正常使用
- **三端使用差异**：admin 视 staff 无 actions，staff 端正常工作
- **风险**：admin 给员工分配 staff 角色后业务列表全空但鉴权通过，假权限假象
- **建议**：admin 显式排除 staff 或为 staff 定义最小 actions

---

## 来自域 23（操作日志）

### E23-action-namespace
- **字段**：operation_logs.action
- **权威约定**："module.method" 格式，无 enum 约束
- **三端使用差异**：pickup-records.ts:346 写成裸 'create'（违反约定）
- **风险**：未来漂移 + 查询条件失效
- **建议**：固化常量字典或在 admin lib 加 typed Action union；至少修这一处 outlier

### E23-source-domain
- **字段**：operation_logs.source
- **隐式取值**：5 值（adminApi / staffApi / clientApi / payNotify / cronTask）
- **三端使用差异**：schema 是 text 无约束
- **建议**：加 CHECK 或 enum 类型

### E23-target-type
- **字段**：operation_logs.target_type
- **隐式取值**：~25 种（见 logs-page.tsx:62-85 字典）
- **风险**：未来漂移中等
- **建议**：同 source 处理

---

## 来自域 24（品项分类动态字段）

### E24-product-kind-dynamic
- **字段名**：product_categories.product_kind
- **权威值**：text 自由文本（DB 驱动设计）
- **三端使用差异**：staff `CARD_PRODUCT_KINDS = ['充值卡','体验卡']` 常量，shopInit 直接用未走 cardKinds DB 路径；admin `PRODUCT_KIND_CHOICES = ['组合套餐','普通商品','体验卡','充值卡']` 前端硬编码；admin `CARD_PRODUCT_KINDS` deprecated 常量保留
- **风险**："DB 驱动"在三处兜底/字面量上半透明
- **建议**：见 [S24-1](./SCHEMA-CHANGES.md)

### E24-card-recharge-magic-string
- **字面量**：`'充值卡'`
- **使用情况**：staff/admin 共 12+ 处业务 SQL / TypeScript 字面量比较，且测试 lock
- **风险**：admin 改名瞬间击穿小美客/体验客判定 + 充值卡守卫
- **建议**：升格为 capability 列 `is_recharge_card`（[S24-1](./SCHEMA-CHANGES.md)）

### E24-display-icon-dead
- **字段**：product_categories.display_icon
- **现状**：admin 表单写入 ✓，staff / client 0 SELECT 0 渲染
- **建议**：决策"删除"或"在 admin 详情页/列表渲染"

---

## 来自域 25（流量 / 推广员）

### E25-customer-source（追加 audit-25 命中）
- **关联**：[E10-customer-source](./ENUM-AUDIT.md) + [P1-25-08](./audit-25-traffic-promoter.md)
- **复测确认**：三端各持一份硬编码 10 值副本（admin select / client sourceGroups / DB enum），新渠道扩展需三处同步
- **业务现实**：customer_source 在 WorkFine 同步顾客上 100% NULL（[P1-25-10](./audit-25-traffic-promoter.md)），admin filter 选 source 时这部分顾客全部不可见

### E25-role-type-promoter
- **现象**：staffApi/__tests__/routes/allocation.test.js:685 出现 `roleType='推广师' commissionRate=0.1`，但 staffApi/routes/allocation.js 实际 sa 写入路径不按 promoter 分支构造该 roleType
- **风险**：测试断言领先于代码实现（与 audit-08 P0-08-06 同模式）
- **建议**：删除测试或补完代码实现

---

## 来自横切 CC1（数值精度与金额）

无新枚举（CC1 是数值/精度领域，与枚举集合无直接关联）。

**2026-04-26 用户决策**：保留 `sale_allocations.allocationRatio = NUMERIC(5,2)`（业务上够用，无需小数 4 位精度），PLAN §3 CC1 第 3 项措辞已校正。但 ratio 仍需 IN-集合 CHECK 兜底（admin 信任前端可写 9.99 的资损通道独立于精度问题，详见 [S-CC1-1](./SCHEMA-CHANGES.md#s-cc1-1)）。

---

## 来自横切 CC5（错误码与错误前缀）

### E-CC5-error-prefixes（错误前缀官方扩展集，从 4 项扩展为 8 项）
- **类别**：约定常量（非 PG 枚举）
- **当前权威值（4 项）**：UNAUTHORIZED: / PHONE_REQUIRED: / INVALID_PARAMS: / PERMISSION_DENIED:
- **建议扩展值（8 项）**：
  - `UNAUTHORIZED:` → -401（未认证 / 缺 OPENID）
  - `PHONE_REQUIRED:` → -403（缺手机号绑定）
  - `INVALID_PARAMS:` → -400（参数不合法）
  - `PERMISSION_DENIED:` → -403（无权限）
  - `NOT_FOUND:` → -404（资源不存在，staff 已用 1 次）
  - `INSUFFICIENT_BALANCE:` → -400（业务约束：余额/次数不足，事实标准 staff 5 + client 5 + admin 2）
  - `CONFLICT:` → -409（业务并发冲突 / 资源已存在）
  - `INVALID_STATE:` → -400（状态机阻断，事实标准 staff 2 + admin 3）
- **三端使用差异**：admin 47 处裸自定义前缀（CARD_*/ORDER_*/INSUFFICIENT_*/OVERPAY 等）；staff/client knownTypes 9/6 项分裂；前端 errorType 几乎闲置
- **风险**：前端按前缀 toast 文案映射会落入"未识别错误"分支
- **建议**：见 [S-CC5-1 / S-CC5-3](./SCHEMA-CHANGES.md#s-cc5-1)；admin 自定义 22 项作废合并

---

## 来自横切 CC6（PII）

无新枚举（CC6 横切域不涉及枚举）。

---

## 来自横切 CC7（时间字段）

无新枚举（CC7 横切域与枚举值集合无关）。

---

## 来自横切 CC8（WXML/Vant）

### E-CC8-appointment-closed
- **枚举名**：appointmentStatusEnum
- **权威值**：5 值（待确认 / 已确认 / 已完成 / 已取消 / 已关闭）db/schema/enums.ts:70
- **三端使用差异**：client `pages/appointment/appointment.ts:9-14 STATUS_META` 仅 4 key + `appointment.wxml:14-17` Tab 缺 `已关闭`
- **风险**：cron 写入 `已关闭` 后客户端列表渲染断裂（与 audit-06 P0-06-04 过期关闭机制脱节同源）
- **建议**：client UI 补齐 STATUS_META[已关闭] + Tab

### E-CC8-refund-vs-unbind
- **枚举名**：orderStatusEnum.待审批 vs storeUnbindRequestStatusEnum.待处理
- **现象**：审批类两 enum 字面量分裂（"待审批" vs "待处理"）
- **风险**：UI 文案心智不一致
- **建议**：引入 `utils/status-label.ts` 字典层做后端 enum→UI label 映射，避免直透

---

## 来自横切 CC9（测试与迁移残留）

无新枚举值漂移。已知漂移项：
- `'组合套餐'` 不在 productKind 4 值内（baseline reset 时移除），但 admin/staff 前端 4 选项仍硬编码（已记 [P1-CC9-02](./audit-CC9-test-migration-residue.md)，归 [S-CC9-1](./SCHEMA-CHANGES.md#s-cc9-1)）
- `'福利活动'` 在 staff product.test.js 是**正向使用**作为新增 kind 案例 OK
- `big_category` / `workfine_source` 仅在 `db/scripts/sync-products-from-workfine.js` 遗留（归 [P2-CC9-08](./audit-CC9-test-migration-residue.md)）

