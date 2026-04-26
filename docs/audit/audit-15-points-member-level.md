# 审计报告：积分 + 等级跳档 (15)

**审计时间**：2026-04-25 23:00（中国上海）
**域 ID**：15
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：
- `notes/tickets/archives/2026-04-24-points-accrual-on-sale-order.md`（消费积分 ticket）
- `notes/tickets/archives/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`（150d 保级 + 三件套）
- `notes/tickets/archives/1-bug-memory-member-level-boundary-overlap.md`

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| 流水表 | `db/schema/points.ts:11`（`point_transactions`） | ↑ | ↑ |
| 余额缓存 | `db/schema/user.ts:72`（`points_balance`） | ↑ | ↑ |
| 等级字段 | `db/schema/user.ts:36-42`（`member_level/_locked_until/_upgraded_at/old_member_level`） | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:93`（5 值：初/星/粉/金/黑）| ↑ | ↑ |
| 列表 / 流水 Action / Route | `fengyu-admin/src/actions/points.ts:98 getPointTransactionsPaginated` | — | `fengyu-client/cloudfunctions/clientApi/routes/points.js:14 balance / :37 history` |
| 列表前端 | `fengyu-admin/src/app/(main)/points/page.tsx:9` + `_components/points-page.tsx` | — | `pagesProfile/points`（前端，未审计） |
| 消费写入工具 | — | `fengyu-staff/cloudfunctions/staffApi/utils/points.js:27` | `fengyu-client/cloudfunctions/clientApi/utils/points.js:23` |
| 支付回调写入 | — | — | `fengyu-client/cloudfunctions/payNotify/points.js:11` + `payNotify/index.js:467` |
| 触发点 | (P0 缺) `recordPayment / confirmOfflinePayment / approveRefund` | `routes/order.js:992 confirmOffline` + `:1631 approveRefund` | `routes/order.js:1461 confirmPrepaidFull` + `:1712 repay` + `payNotify/index.js:467` |
| 跳档 cron | `fengyu-admin/src/cron/steps/refresh-member-levels.ts:44` + `lib/member-level.ts:25` + `lib/member-threshold.ts:20` | — | — |
| 余额对账 cron | `fengyu-admin/src/cron/steps/audit-points-balance.ts:24` | — | — |
| 升级三件套 | `refresh-member-levels.ts:228 grantUpgradeBenefits` + `grant-birthday-benefits.ts:108` + `grant-thanksgiving-benefits.ts:118` | — | — |
| 测试 | `cron/__tests__/refresh-member-levels.test.ts` + `audit-points-balance.test.ts` + `lib/member-threshold.test.ts` | — | — |

---

## 2. 数据流图

```
[积分获取/冲销]
client.confirmPrepaidFull / client.repay
staff.confirmOffline / staff.approveRefund
payNotify(微信回调)
   │ pg.transaction { ... settlePointsSafe(client, originalSaleOrderId, src) }
   ▼
settlePointsForOrder(originalSaleOrderId)
   1. SELECT client_user_id, sale_order_type FROM sale_orders WHERE sale_order_id=$1 FOR UPDATE
      └─ 跳过：anonymous-order / non-销售单 / order-not-found
   2. SELECT SUM(paid_amount) FROM sale_orders WHERE sale_order_id=$1 OR ref_sale_order_id=$1
      └─ 整条订单链净额 netSettled（退款单 paid_amount<0）
   3. expected = floor(max(0, netSettled) / 100)
   4. granted  = SUM(amount) FROM point_transactions WHERE ref_order_id=$1
   5. delta = expected - granted
      └─ delta=0  天然幂等
      └─ delta>0  INSERT '消费赠送' + UPDATE points_balance += delta
      └─ delta<0  INSERT '消费冲销' + UPDATE points_balance += delta（负值）

[admin 三大触发点不调用 settlePoints —— P0-15-01]
admin.confirmOfflinePayment(orders.ts:426) ❌
admin.recordPayment(orders.ts:1522)        ❌
admin.approveRefund(refunds.ts:778)        ❌

[等级跳档（cronTask STEP 2，每日 03:00 Asia/Shanghai）]
SELECT user_id FROM client_wechat_users WHERE customer_type='会员客'
   └─ 仅 '会员客' 才参与重算（流量/体验/小美客 永远拿不到 member_level）
foreach user:
   spend = SUM(paid_amount) FROM sale_orders
            WHERE client_user_id=$1
              AND sale_order_type='销售单'
              AND paid_amount>0
              AND paid_at >= NOW() - INTERVAL '12 months'
   newLevel = determineMemberLevel(spend, threshold)
              黑钻≥10W / 金钻≥6W / 粉钻≥3W / 星钻≥1W / 初钻≥threshold(1980) / 否则 null
   if upgrade  → UPDATE level + 写 150d locked_until + memberLevelChange log + 三件套
   if downgrade:
       if locked_until > now → 仅记 memberLevelHeld 日志（保级）
       else                  → UPDATE level + 清 locked_until + memberLevelChange log

[STEP 5 余额对账（仅告警不修复）]
WITH sums AS (SELECT user_id, SUM(amount) FROM point_transactions GROUP BY 1)
SELECT 不一致行 → INSERT operation_logs + notifyOps(企微 webhook)
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### P0-15-01 admin 三大资金触发点完全不调用 settlePoints —— 资损（积分漏发 / 退款漏冲销）
- **文件**：
  - `fengyu-admin/src/actions/orders.ts:426 confirmOfflinePayment`
  - `fengyu-admin/src/actions/orders.ts:1522 recordPayment`
  - `fengyu-admin/src/actions/refunds.ts:778 approveRefund`
- **现象**：admin 端三个资金状态推进入口（线下确认收款 / 录入回款 / 审批退款）均完整写 `sale_orders.paid_amount + sale_order_payments` 流水，但**全部不调用** `settlePointsSafe`：
  - `confirmOfflinePayment` 事务内仅 `UPDATE sale_orders + INSERT sale_items.expire_date + applyRechargeOnOrderPaid`（`orders.ts:447-475`），无 settle。
  - `recordPayment` 事务内 `INSERT 凭证 FY-HKD + INSERT payments + 重算 paid_amount`（`orders.ts:1647-1755`），无 settle。
  - `approveRefund` 事务内 `回冲储值卡 + 翻 payments + 重算 paid_amount + refreshSpendingTier`（`refunds.ts:925`），无 settle。
- **对比**：staff/client/payNotify 同语义触发点全部调用：
  - `staffApi/routes/order.js:992` confirmOffline → settle
  - `staffApi/routes/order.js:1631` approveRefund → settle
  - `clientApi/routes/order.js:1461` confirmPrepaidFull → settle
  - `clientApi/routes/order.js:1712` repay → settle
  - `payNotify/index.js:467` 微信回调 → settle
- **风险**：
  1. **退款积分不冲销（资损）**：业务流程"admin 审批退款"路径不会写 `'消费冲销'` 流水，顾客继续享有已退款金额对应的积分。攻击模型：顾客下单 1 万 → 拿 100 积分 → 通过 admin 审批退款 → 仍持 100 积分（payNotify/staff 路径写过的赠送不被冲销）。
  2. **回款积分漏发**：`recordPayment` 是 admin 录入"线下回款 / 储值卡回款"凭证单（FY-HKD），原销售单 `paid_amount` 累加但流水永不写。
  3. **线下确认积分漏发**：`confirmOfflinePayment` 把订单从 `'待确认收款'` 推到 `'已支付'`，paid_amount 在该路径下也无 settle 触发。
- **复现**：
  1. 顾客 A 下 1 笔销售单 5000 元，待支付。
  2. admin 走"录入回款"将 5000 全部线下回款 → `paid_amount=5000`，但 `point_transactions` 无新行 → 顾客本应得 50 积分丢失。
  3. 顾客 B 已支付销售单 8000 → 通过 staff/payNotify 已发 80 积分。admin 走 `approveRefund` 退 8000 → `paid_amount` 退至 0 但 80 积分残留。
- **修复**：(L7 admin actions)
  - 三处事务尾部均补 `await settlePointsSafe(tx, /* 原销售单 saleOrderId */, 'admin.<source>')`。
  - 接入方式参考 `staffApi/utils/points.js`，admin 需新建 `lib/points-settle.ts`（drizzle 风格）或直接复用 raw SQL（参考 `audit-points-balance.ts` 的 `db.execute(sql\`...\`)` 模式）。

#### P0-15-02 settlePoints 三个副本（staffApi / clientApi / payNotify）逻辑漂移高风险
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/utils/points.js`（132 行）
  - `fengyu-client/cloudfunctions/clientApi/utils/points.js`（114 行）
  - `fengyu-client/cloudfunctions/payNotify/points.js`（102 行）
- **现象**：三份代码逐字复制（注释如 "三端任一处修改后必须同步另外两端"），cron-worker 也另写一份会员升级积分逻辑（`refresh-member-levels.ts:228 grantUpgradeBenefits`）。
- **风险**：
  - 任一端未同步即出现"赠送 vs 冲销"语义漂移；payNotify 有 `'消费赠送'/'消费冲销'`、cron-worker 有 `'等级升级奖励'`、生日/感恩有 `'生日积分'/'感恩回馈'`，类型字符串散落 5 处。
  - 当前 admin 不参与 settle 又新增第 4 套口径（一旦补 P0-15-01 就需要第 4 份 SQL）。
- **修复**：(L0/L3)
  - 短期：把 `point_transactions.type` 升级为 PG enum + DB CHECK，统一 5 种值（消费赠送 / 消费冲销 / 等级升级奖励 / 生日积分 / 感恩回馈），admin 任意手动调整需新增类型则走迁移；ENUM 加固让漂移立即失败。
  - 长期：抽公共 npm 包或 db function `pg_settle_points(p_order_id text)`（参考 audit-04 P0-04-01 类似抽象建议）。

#### P0-15-03 客户端余额展示 SQL 把 NULL 误算为 0，对未绑定手机号的访问伪造"零余额而非未授权"
- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/points.js:18-32`
- **现象**：`balance` / `history` 都不调用 `requirePhone()`。auth 中间件在 openid 未匹配 client_wechat_users 时把 `userId` 设为 `null`（`middleware/auth.js:54-61`），随后 SQL `WHERE user_id = null` 返回 0 行 → balance 显示 0、history 显示空。
- **风险**：
  - 不直接越权（绑定 openid 的 user 才能拿到自己的余额，符合 §1 真实约束 #6 组织域隔离）。
  - 但与 audit-12 / audit-06 等对齐"未绑定 phone 的页面应明确 `PHONE_REQUIRED:`"的策略不一致，会让用户在"未绑定手机号但跳到积分页"时看到伪 0 而无错误提示。
  - 列入 P0 是因为：`history` 暴露顾客 `pt.ref_order_id`（含 sale_order_id），属于 PII（订单号可枚举猜测）。当前是行级隔离正确——但**未对 history 限制时间窗口和总返回上限**：默认 pageSize=20、page=1，但顾客可主动请求 page=999、pageSize=20 → 全量积分流水分页拉取，没有"最大半年"窗口；非典型的隐私合规问题。
- **修复**：(L3)
  - `balance` / `history` 路由前置 `requirePhone()`（与 `coupon.list` / `card.history` 模式对齐）。
  - `history` 加最大窗口（如 12 个月）+ pageSize 上限 100。
  - 严格语义：openid 未在 client_wechat_users 时返回 `UNAUTHORIZED:` 而非空 0。

#### P0-15-04 cron 跳档算法只重算 customer_type='会员客' 的行，会员状态被冻结无法升级
- **文件**：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:48-56`
- **SQL**：`SELECT ... FROM client_wechat_users WHERE customer_type = '会员客'`
- **现象**：cron STEP 2 跳档只对 `customer_type='会员客'` 的顾客生效。但 `customer_type` 跃迁口径是 staff/order.js + payNotify 维护（参考 audit-10 P0-10-06 customer_type vs spending_tier 漂移），跃迁判断与等级判断完全独立：
  - 顾客 A 未跃迁到"会员客"（仅小美客）但已消费 6 万 → 永远拿不到 member_level（粉钻/金钻通通无）。
  - 顾客 B 早期跃迁到会员客，后退款 + 消费下降 → cron 仍以会员客身份重算 → 这条还正常。
- **风险**：审计 #10 已揭示 customer_type 双口径漂移（成员等级"消费 12 月>=1980"/客户类型"消费>=2400 跃迁"），现在又叠加：
  - **member_level 跳档隐式预设条件 = customer_type 已是会员客**，与 [project_member_level_rules](memory:project_member_level_rules) 规范"年度消费跳档"不一致（规范说每个顾客跳档，不限制类型）。
  - 业务表现：流量客 / 小美客无论怎么消费都拿不到等级 → 影响生日/感恩三件套（其入口 `member_level IS NOT NULL`，见 `grant-birthday-benefits.ts:51`）→ 升级倾斜 + 福利缺失。
- **复现**：手工 INSERT 一个 `customer_type='小美客'` + `paid_amount=70000` 的销售单 → 跑 cron → SELECT member_level 仍为 null。
- **修复**：(L7)
  - 选项 A：去掉 `WHERE customer_type='会员客'`，所有顾客都参与跳档（与产品语义一致；但每日 row 数会从 10% → 100% 涨 10×）。
  - 选项 B：先跑 customer_type 重算 cron（当前未实现，与 audit-10 P0-10-06 同根因），保证"达到消费门槛 → 自动跃迁会员客"再跳档。
  - 选项 C：[memory project_member_level_rules](memory:project_member_level_rules) 中新增"等级仅限会员客"约束，更新 spec 与 cron 注释。

#### P0-15-05 cron 跳档窗口 paid_at >= NOW() - 12 months 与 spending_tier 累计口径漂移（retain audit-10 P0-10-06）
- **文件**：`refresh-member-levels.ts:66-73`
- **SQL**：`SUM(paid_amount) WHERE sale_order_type='销售单' AND paid_amount>0 AND paid_at >= NOW() - INTERVAL '12 months'`
- **风险**：
  - **member_level**：滚动 12 月（基于 paid_at）。
  - **spending_tier**（`db/schema/enums.ts:112` 6 档：10W+/6-10W/3-6W/1-3W/1990-1W/<1990）：累计（参考 audit-10）。
  - **同一顾客 X 万元消费可对 spending_tier 标注为粉钻金额段，但 member_level 已降为初钻或 null**。运营无法判断"高净值老客 vs 高潜力新客"。
- **修复**：与 audit-10 P0-10-06 合并修复路线（统一为滚动 12 月或累计，同步给 customer_type 跃迁阈值）。

#### P0-15-06 跳档去掉了 'paid_amount IS NOT NULL'，但允许 paid_amount=0 的销售单参与（数据层不阻断）
- **文件**：`refresh-member-levels.ts:71-72`
- **现象**：`AND paid_amount > 0` 已正确过滤 0 元单。**但**回款单/转换单/退款单（其 `sale_order_type ≠ '销售单'`）已通过类型过滤排除。这条**目前没问题**——但缺一个 schema 层守卫：`sale_orders.paid_amount` 没有 `CHECK (paid_amount IS NOT NULL)`，schema 仅 `numeric default 0`。如果有路径意外写 `null`，跳档 SUM 会忽略该行而非报错。
- **修复**：(L0) `ALTER TABLE sale_orders ADD CONSTRAINT chk_paid_amount_not_null CHECK (paid_amount IS NOT NULL);`（建议 schema 层强制）。

### 3.2 P1（数据一致 / 状态错乱）

#### P1-15-07 grantUpgradeBenefits 升级三件套写积分顺序：先 INSERT 再 UPDATE balance，事务跨多步无 row 锁
- **文件**：`refresh-member-levels.ts:248-263`
- **SQL**：
  ```sql
  INSERT INTO point_transactions ... ON CONFLICT (external_ref) DO NOTHING RETURNING id;
  -- if inserted.length > 0:
  UPDATE client_wechat_users SET points_balance = COALESCE(points_balance,0) + $1 ...
  ```
- **风险**：
  - 同一事务，`ON CONFLICT DO NOTHING RETURNING id` 仅在新写入返回 id，UPDATE 由 length 守卫。语义对。
  - 但 UPDATE 不带 row lock（`points_balance = points_balance + delta` 无 `FOR UPDATE`）；两个并发事务同时升级同一 user（理论上 cron 单线程不会，但若 admin 接入手动调整即触发） → 最后写赢，**但写入金额不会丢**（PG `column = column + N` 在 read-committed 下安全）。仍属于"读到的旧值已变化"问题，建议改 `points_balance = points_balance + N`（已是该形态 ✅）。
  - **顺序问题**：先 INSERT 后 UPDATE。如果 UPDATE 失败回滚，INSERT 也会回滚（同事务）— OK。
- **结论**：当前实现幂等正确；记 P1 为 **schema 缺 (user_id, type, ref_order_id) 联合 UNIQUE 兜底**——目前仅 `external_ref` 有 partial unique（`points.ts:29`），消费赠送场景的 `ref_order_id` 没有 UNIQUE 约束。当前靠 settle 算法的"差值法"幂等（granted vs expected），**任何外部手动 INSERT 重复都不会被 DB 拒绝**。
- **修复**：(L0) 加 partial unique `CREATE UNIQUE INDEX uq_pt_consumption ON point_transactions(user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销');` —— 与 audit-14 S14-01 对齐模式。

#### P1-15-08 admin 流水列表 scopeCondition 单位是 `boundStoreId`，对未绑定门店顾客的流水不可见
- **文件**：`fengyu-admin/src/actions/points.ts:52`
- **代码**：`scopeCondition(session!, clientWechatUsers.boundStoreId)`
- **现象**：非 admin 的 finance/manager 只能看 `bound_store_id IN (scopeStoreIds)` 的顾客积分流水。现实中 `bound_store_id IS NULL`（孤儿档案 / WorkFine 同步未补齐 / 线上未绑定）的顾客流水**对所有非 admin 完全不可见**——但他们仍可通过 cron 升级享有积分。
- **风险**：
  - finance 角色对账时漏行 → P0-15-01 修复后回头看更严重。
  - manager 视角看不到自己签约但未"绑定门店"的客户流水，影响异常诊断。
- **修复**：(L7) finance 角色不做 store scope 过滤（与 sale_orders / sale_allocations 一致），或显式把 NULL 行视作"全员可见"。

#### P1-15-09 distinctTypes 暴露所有顾客流水类型，无 scope 守卫
- **文件**：`actions/points.ts:163-167`
- **现象**：`distinctTypes` 子查询同 conditions（含 scope），但实际意图是"动态填充类型筛选下拉"——它**也**应用了 scope 过滤，逻辑上**正确**；只是新加的"等级升级奖励"等类型可能在 manager scope 下隐藏。
- **风险**：UI 下拉项与全局类型集合不一致，运营人员无法筛"系统未发的类型"做 negative check。
- **修复**：(L7) `distinctTypes` 不要应用 scope（仅返回静态/全局类型集合）。

#### P1-15-10 跳档算法 LEVEL_RANK['null'] = 0 字符串硬编码兜底，严重依赖 String() 隐式转
- **文件**：`fengyu-admin/src/cron/lib/member-level.ts:16-23`
- **代码**：`LEVEL_RANK[String(to)]` 当 `to=null` 时是字符串 `'null'`
- **风险**：可读性差；测试 mock 一旦传 `'undefined'` / `'NaN'` 都会落到默认 0 但不报错；类型一致性脆弱。
- **修复**：(L7) 改用 nullish 判断而非字符串比较，或把 LEVEL_RANK 改为 `Map<MemberLevel | null, number>`。

#### P1-15-11 settle 跳过 anonymous-order 无 operation_logs 记录，匿名单消费无法事后回填
- **文件**：`utils/points.js:43-45`（三端副本均如此）
- **现象**：销售单 `client_user_id IS NULL`（顾客未注册小程序但 admin / staff 录单）→ settle 直接 return skipped='anonymous-order'，不写任何审计。
- **风险**：日后顾客绑卡 → 老订单永远拿不到积分（settle 只对触发点的 ref 单跑，没有补单机制）。
- **修复**：(L3) skipped='anonymous-order' 时写一行 `operation_logs(action='points.skippedAnonymous')`，未来 cron 可扫描该日志做补发。

#### P1-15-12 admin 后台无任何"手动充扣积分"路径，但权限矩阵 `point_transaction:list` 已足够 → 调整需绕过路由
- **文件**：`fengyu-admin/src/lib/permissions.ts:28,49,62` + `actions/points.ts`
- **现象**：admin / manager / finance 都有 `point_transaction:list`，但**没有** `point_transaction:adjust` 或 `:create` 权限定义；`actions/points.ts` 只导出 `getPointTransactionsPaginated`，无修改入口。
- **风险**：业务运营不能手动加扣分（如客诉补偿）；只能通过 cron 间接发或直接 psql（违反 db/CLAUDE.md 禁止 DDL/直连写入）。
- **修复**：(L7) 视产品需求，要么添加 admin 调整 action（带强制 operation_logs + 必填理由），要么明确"积分仅由系统按规则发放"。

#### P1-15-13 audit-points-balance 仅告警不修复 → 偏差累积无回收路径
- **文件**：`fengyu-admin/src/cron/steps/audit-points-balance.ts:6-13`
- **现象**：决策 D7 故意只告警不 UPDATE balance（避免掩盖上游 bug）。**但**仅 notifyOps 企微 webhook + operation_logs 记录，**没有任何后续工单 / SLA / 自动修复路径**。一次发现 100 条偏差 → 5 行 preview → 余下 95 条无可索引来源（详细信息埋在 operation_logs.detail jsonb 内）。
- **风险**：audit 5 月报告无人看 → 偏差永久累积（与 P0-15-01 admin 漏发链式叠加更糟）。
- **修复**：(L7)
  - operation_logs.detail 增加 `expected/cached/delta` 三字段索引化（json path 索引）。
  - 偏差超过阈值（如 N=10 条 / 累计金额 K）时升级为 P1 告警。

#### P1-15-14 grantBirthdayBenefits 只对 `member_level IS NOT NULL` 的顾客生效
- **文件**：`grant-birthday-benefits.ts:51-54`
- **SQL**：`WHERE birthday IS NOT NULL AND member_level IS NOT NULL AND ...`
- **风险**：与 P0-15-04 串联——"流量客"/"小美客"哪怕生日撞日也拿不到生日积分。spec 是否需要"未升级会员的顾客也送基础生日积分"由产品决定。
- **修复**：(L7) 与 P0-15-04 一同评估。

### 3.3 P2（代码质量 / 可维护）

#### P2-15-15 三端 settlePoints 副本注释自相矛盾
- **文件**：`staffApi/utils/points.js:7-10` vs `clientApi/utils/points.js:8-10` vs `payNotify/points.js:4-7`
- **现象**：staffApi 注释写 "对'原销售单'维度调用 settlePointsForOrder"；clientApi 注释写 "三端任一处修改后必须同步另外两份"；payNotify 注释写 "三端任一处修改后必须同步其它两份"——彼此差几个字，给阅读者造成"哪份是权威源"的不确定。
- **修复**：(L3) 抽 README 或 ticket 链接到一处。

#### P2-15-16 LEVEL_RANK 与 memberLevelEnum 顺序硬绑定，更新枚举需双改
- **文件**：`cron/lib/member-level.ts:14-23` + `db/schema/enums.ts:93`
- **现象**：枚举 `['初钻','星钻','粉钻','金钻','黑钻']` 与 LEVEL_RANK 1..5 是**隐式约定**。如果未来加"白钻"插入到中间，LEVEL_RANK 必须同步改否则跳档错位。
- **修复**：(L0/L7) `LEVEL_RANK` 改为 `memberLevelEnum.enumValues.reduce((m, v, i) => { m[v] = i+1; return m }, { null: 0 })` 自动生成。

#### P2-15-17 client points.history 无最大时间窗口
- **文件**：`clientApi/routes/points.js:37-58`
- **现象**：参考 audit-12 / audit-13 P1，client.list 应限定半年/一年时间窗口；当前 `points.history` 仅 `LIMIT $2 OFFSET $3`，可分页拉取全量。
- **修复**：(L3) 加 `AND created_at >= NOW() - INTERVAL '12 months'` 或 spec 明确允许全量。

#### P2-15-18 PointTransaction.amount 是 integer，溢出风险隐患
- **文件**：`db/schema/points.ts:20`
- **现象**：`amount integer NOT NULL`（PG int4，±21 亿）。一次性"等级升级奖励"配置上限若超 21 亿会写失败；`points_balance` 也是 integer，长尾累积 / 错误回放可触底负值。
- **修复**：(L0) 切 `bigint` 防御，或加 `CHECK (amount > -10000000 AND amount < 10000000)`。

#### P2-15-19 settlePoints `Math.floor(Math.max(0, netSettled) / 100)` 边界注释不足
- **文件**：`utils/points.js:62-63`
- **现象**：决策 D3"不允许负余额，expected 下界为 0"代码现实是"链净额为负→expected=0→delta = 0 - granted = -granted"（即冲销整条已发）。和文档"max(0, netSettled)"贴合，但未单元测试覆盖"链净额转负"边界。
- **修复**：(L9) 补单测：链净额 -50 / +50 / +99 / +100 临界。

#### P2-15-20 admin points 列表无导出 / 无审计行为日志
- **文件**：`actions/points.ts:98 getPointTransactionsPaginated`
- **现象**：函数仅 SELECT，但 finance / manager 频繁拉取大数据集 → 无 `logOperation('points.list', ...)` 记录谁查询了哪些用户的流水。运营 PII 合规可能要求。
- **修复**：(L7) 与 audit-13 / audit-14 admin list 行为对齐策略。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | cron | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|------|--------|
| 资金触发 settle | ❌ 三处全无 | ✅ confirmOffline / approveRefund | ✅ confirmPrepaidFull / repay | ✅ 主回调 | — | 资损（见 P0-15-01） | P0 |
| 类型字符串 | distinctTypes 动态读 | '消费赠送'/'消费冲销' | 同 | 同 | '等级升级奖励'/'生日积分'/'感恩回馈' | 漂移失控 | P0 |
| settle 副本 | 缺 | utils/points.js | utils/points.js | points.js | 自写 grantUpgradeBenefits 等 | 修一处忘三处 | P0 |
| 跳档窗口 | — | — | — | — | 滚动 12 月（paid_at） | 与 spending_tier 累计漂移 | P0 |
| 跳档目标人群 | — | — | — | — | 仅 customer_type='会员客' | 流量/体验/小美 永远无 level | P0 |
| balance 鉴权 | requirePermission | — | 仅 auth，未 requirePhone | — | — | 未绑定 phone 看到伪 0 | P0 |
| points_balance 一致性 | 仅 audit 告警 | — | — | — | STEP 5 | 偏差无修复 | P1 |
| amount 类型 | integer | integer | integer | integer | integer | 21 亿溢出 | P2 |
| ref_order_id UNIQUE | 仅 external_ref（partial） | 同 | 同 | 同 | 同 | 重复消费赠送可塞入 | P1 |
| 时间窗口 | 后端 startDate/endDate | — | 无窗口 | — | INTERVAL '12 months' 硬编码 | client 全量泄露风险 | P2 |

---

## 5. 横切检查（CC1-CC9）

- [ ] **CC1 数值精度**：`amount integer` 无 NUMERIC，无负值/上限 CHECK（P2-15-18 / P0-15-06）；settle 用 `Math.floor` + `Math.max(0, netSettled)` 经多次回款/退款单测试链净额，但未覆盖临界（P2-15-19）。
- [ ] **CC2 并发幂等**：settle 用"差值法 delta=expected-granted"天然幂等 ✅；ref_order_id 缺 UNIQUE 兜底（P1-15-07）；`points_balance += delta` 在 PG read-committed 下安全 ✅；cron STEP 2 单线程串行 ✅；audit-points-balance 仅告警 ✅。**但 admin 三处缺 settle 直接破坏幂等链**（P0-15-01）。
- [ ] **CC3 组织隔离**：admin scope 基于 `client_wechat_users.bound_store_id`，对孤儿档案不可见（P1-15-08）；client 流水按 openid → user_id 严格隔离 ✅；staff 不参与 list（无入口）。
- [ ] **CC4 后端鉴权**：admin `requirePermission('point_transaction:list')` ✅；client `balance/history` **未** `requirePhone()`（P0-15-03）。
- [ ] **CC5 错误码**：`points.js` 无错误前缀使用——因为没有错误抛出路径（settle 失败包成 `skipped`/`error` 字段，operation_logs 写入）。这种"静默吞错"模式 OK 但应在 ticket 显式标注。
- [ ] **CC6 PII**：流水含 `ref_order_id` 顾客订单号，client.history 无窗口（P2-15-17）；admin 无 list 操作日志（P2-15-20）。
- [ ] **CC7 时间字段**：`point_transactions.created_at notNull defaultNow()` ✅；`points_updated_at` 应用层维护；`member_level_upgraded_at` 用 NOW() 写 ✅。`paid_at >= NOW() - INTERVAL '12 months'` 服务器时区依赖 PG 默认（PG 配置 Asia/Shanghai 才正确，记入 CC7）。
- [ ] **CC8 WXML/Vant**：客户端 points 页面前端未审计（不在本轮范围）。
- [ ] **CC9 测试与残留**：cron `__tests__/refresh-member-levels.test.ts` 覆盖 4 路径（升 / 降 / 保级 / 黑钻特例）✅；`audit-points-balance.test.ts` ✅；`utils/points.js` 三端副本无单测（云函数侧）；admin `actions/points.ts` 无 vitest 覆盖。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/points.ts` | `type` 改 enum（消费赠送/消费冲销/等级升级奖励/生日积分/感恩回馈/手动调整）；加 `(user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')` partial UNIQUE；amount 改 bigint | P0-15-02 / P1-15-07 / P2-15-18 |
| L0 schema | `db/schema/points.ts` | 加 `CHECK (amount BETWEEN -10000000 AND 10000000)` | P2-15-18 |
| L0 schema | `db/schema/order.ts` | `paid_amount NOT NULL` CHECK | P0-15-06 |
| L3 云函数 utils | `staffApi/utils/points.js` + `clientApi/utils/points.js` + `payNotify/points.js` | 抽公共 npm 或 db function | P0-15-02 |
| L3 cloudfunctions | `clientApi/routes/points.js` | 前置 `requirePhone()`；history 加 12 月窗口 | P0-15-03 / P2-15-17 |
| L3 cloudfunctions | 三端 `utils/points.js` | skipped='anonymous-order' 写 operation_logs | P1-15-11 |
| L7 admin actions | `actions/orders.ts` confirmOfflinePayment / recordPayment | 事务尾部加 settlePointsSafe | P0-15-01 |
| L7 admin actions | `actions/refunds.ts` approveRefund | 事务尾部加 settlePointsSafe(refSaleOrderId) | P0-15-01 |
| L7 admin cron | `cron/steps/refresh-member-levels.ts:48-56` | 去 `customer_type='会员客'` 限制 OR 与 audit-10 P0-10-06 合并修复 | P0-15-04 / P0-15-05 |
| L7 admin actions | `actions/points.ts:163` distinctTypes | scope 拆为静态枚举集合 | P1-15-09 |
| L7 admin lib | `cron/lib/member-level.ts` | LEVEL_RANK 自动从 enum 生成；nullish 判定替代字符串 | P1-15-10 / P2-15-16 |
| L7 admin actions | `actions/points.ts` | 增加 `logOperation('points.list', ...)` | P2-15-20 |
| L9 测试 | `cron/lib/member-level.test.ts` | 链净额负值 / 临界 99/100 单测 | P2-15-19 |
| L9 测试 | 三端 utils/points.js | 加云函数测试 | CC9 |

---

## 7. 验证 SQL（仅 SELECT / EXPLAIN，目标 5434/fengyu）

```sql
-- 7.1 验证 audit-points-balance 是否有现存偏差
WITH sums AS (
  SELECT user_id, COALESCE(SUM(amount),0)::int AS total_from_txns
  FROM point_transactions GROUP BY user_id
)
SELECT u.user_id, u.points_balance AS cached, s.total_from_txns AS expected,
       (s.total_from_txns - u.points_balance) AS delta
FROM client_wechat_users u
LEFT JOIN sums s ON s.user_id = u.user_id
WHERE COALESCE(u.points_balance,0) <> COALESCE(s.total_from_txns,0)
LIMIT 20;

-- 7.2 验证 admin recordPayment 路径有多少订单从未进 settle（admin 资损面量化）
-- 思路：找有正向 paid_amount 但 ref_order_id 没在 point_transactions 出现的 sale_orders
SELECT so.sale_order_id, so.client_user_id, so.paid_amount, so.paid_at
FROM sale_orders so
LEFT JOIN point_transactions pt ON pt.ref_order_id = so.sale_order_id
WHERE so.sale_order_type='销售单'
  AND so.paid_amount > 0
  AND so.client_user_id IS NOT NULL
  AND pt.id IS NULL
LIMIT 50;

-- 7.3 检查 customer_type='会员客' 之外但 paid 12 月内 >= 1980 的"应升未升"顾客
SELECT cwu.user_id, cwu.customer_type, cwu.member_level,
       SUM(so.paid_amount) FILTER (
         WHERE so.sale_order_type='销售单' AND so.paid_amount>0
           AND so.paid_at >= NOW() - INTERVAL '12 months'
       ) AS spend12m
FROM client_wechat_users cwu
LEFT JOIN sale_orders so ON so.client_user_id = cwu.user_id
GROUP BY cwu.user_id, cwu.customer_type, cwu.member_level
HAVING cwu.customer_type <> '会员客'
   AND SUM(so.paid_amount) FILTER (
       WHERE so.sale_order_type='销售单' AND so.paid_amount>0
         AND so.paid_at >= NOW() - INTERVAL '12 months'
     ) >= 10000  -- 至少够星钻
ORDER BY spend12m DESC NULLS LAST LIMIT 30;

-- 7.4 检查 ref_order_id 重复 INSERT 案例（partial unique 加上前的脏数据）
SELECT user_id, ref_order_id, type, COUNT(*) cnt
FROM point_transactions
WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
GROUP BY 1,2,3 HAVING COUNT(*) > 1
LIMIT 20;

-- 7.5 EXPLAIN 跳档主查询（每个会员客 1 次 SUM 扫描）
EXPLAIN
SELECT COALESCE(SUM(paid_amount::numeric),0)
FROM sale_orders
WHERE client_user_id = '<user>'
  AND sale_order_type='销售单'
  AND paid_amount > 0
  AND paid_at >= NOW() - INTERVAL '12 months';
-- 期望命中 (client_user_id, sale_order_type, paid_at) 索引；若 seq scan 需新增 index

-- 7.6 验证有多少 anonymous-order（client_user_id IS NULL）销售单未发积分（潜在补发对象）
SELECT COUNT(*) AS anon_orders, SUM(paid_amount) AS anon_paid_total
FROM sale_orders
WHERE sale_order_type='销售单' AND paid_amount > 0 AND client_user_id IS NULL;
```

---

## 8. 回归测试用例（建议）

1. **admin recordPayment 触发 settle**：admin 录入回款 5000 → 顾客 points_balance 增 50；cron audit-points-balance 不再告警此 user。
2. **admin approveRefund 触发 settle**：审批退款 8000 → 写"消费冲销" -80；balance 减 80；customerType / spending_tier 同步联动。
3. **admin confirmOfflinePayment 触发 settle**：状态从 '待确认收款' → '已支付' 时 settle 写 '消费赠送'。
4. **client.points.history 时间窗口**：尝试 `page=1, pageSize=20` 拉超过 12 月之前的流水 → 应空。
5. **client.points.balance 未绑定 phone**：未绑定 phone 调 → 返回 `PHONE_REQUIRED:`，而非空数据。
6. **跳档兼容：流量客消费 11000**：跑 cron → member_level 应升至星钻（修复后）；当前预期 null（漏洞行为）。
7. **跳档边界 9999.99 vs 10000**：精度边界测试。
8. **150d 保级解锁后再跑 cron**：`member_level_locked_until` 已过期 → cron 实际降级（已有测试 ✅）。
9. **member_level upgrade 三件套幂等**：同 user 同 level 重复跑 cron → external_ref 冲突 → DO NOTHING；balance 不重复加。
10. **退款链净额转负边界**：销售单 280 → 退款 90 → 退款 50 → 再退款 200（链净额 -60）→ expected=0；total granted=2 → delta=-2（冲销 2）；balance 总变化 = 0。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（admin 三大触发点漏发已生效，存量需补发；P0-15-04 流量/小美客积压未升级数）
- 修复成本：**M-L**（admin 加 3 处 settle 接入 + drizzle 风格 SQL 抽象 + L0 schema 迁移 + 一次性数据回灌）

---

## 10. 后续待办

- [ ] 与 audit-10 P0-10-06 合并讨论 customer_type vs member_level vs spending_tier 三口径统一时间窗口方案。
- [ ] 与 audit-11 P0 / audit-13 P0-13-08 合并讨论"退款不冲销 X"（券 / 积分 / 卡）的统一修复模板。
- [ ] 写补丁迁移：partial UNIQUE on `point_transactions(user_id, ref_order_id, type)` + amount CHECK + paid_amount NOT NULL。
- [ ] 写一次性脚本：扫 7.2 SQL 找未发 settle 订单 → 跑 settlePointsForOrder 补发；扫 7.3 SQL 找应升未升会员补 cron。
- [ ] admin 端考虑新增 `point_transaction:adjust` 权限 + 手动调整 action（含强制理由 + operation_logs）。
- [ ] member-threshold 配置缓存 5min revalidate vs cron 每日 03:00 跑——若运营改门槛后 5 分钟内会被 cron 用旧值跑。
