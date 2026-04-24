# Ticket：订单消费自动发放积分（含退款/回款冲销）

> 生成日期：2026-04-24
> 最后更新：2026-04-24
> 严重级别：P2
> 端：db + fengyu-client(clientApi) + fengyu-staff(staffApi) + fengyu-admin
> 影响面：积分域新增写入入口；订单支付/退款 5 个触发点；cronTask 兜底清理
> 预计工作量：3 ~ 4 天
>
> **一句话目标**：顾客每笔销售单按 `floor(paid_amount / 100)` 自动获得积分，
> 退款、回款、转换场景下**幂等**冲销/补发，多次部分退款不产生尾差。

---

## 0 一句话背景

系统已有积分流水表 `point_transactions`、余额缓存 `client_wechat_users.points_balance`，
以及客户端 `pagesProfile/points` 展示页，但**消费发放入口完全空缺** —
目前只有 `cronTask` 里"会员升级奖励"一种写入路径。业务希望打通"每消费一笔就送积分"，
并保证退款、回款场景下账户数字正确不错。

---

## 1 现状快照

### 1.1 积分数据模型

**权威流水表** `db/schema/points.ts` → `point_transactions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | bigserial PK | — |
| `user_id` | text | FK → `client_wechat_users.user_id` |
| `type` | text（自由文本，非枚举）| 变动分类，现有 `'等级升级奖励'` |
| `amount` | integer | 正负均可，累加即余额 |
| `ref_order_id` | varchar(30) 可空 | 关联订单 id（`sale_orders.sale_order_id`）|
| `created_at` | timestamp | — |

索引：`idx_point_txns_user_id (user_id)`

**余额缓存** `db/schema/user.ts` → `client_wechat_users`
- `points_balance: integer`
- `points_updated_at: timestamp`

缓存语义：`SUM(point_transactions.amount WHERE user_id = ?)`。当前由 `cronTask` 每日凌晨 3 点重算写入。

### 1.2 订单资金模型（权威源 vs 快照）

| 层 | 位置 | 语义 |
|---|---|---|
| 权威 | `sale_order_payments.amount WHERE status='已支付'` | 每一笔资金变动（含退款负值）|
| 快照 | `sale_orders.paid_amount` | 应等于上述 SUM；退款时累减 |

不变量（应用层维护）：
```
sale_orders.paid_amount = Σ(sale_order_payments.amount
                             WHERE sale_order_id = X
                               AND status = '已支付'
                               AND change_type IN ('首次支付','回款','退款'))
```

### 1.3 五种 `sale_order_type` 金额流向

| 类型 | `total_amount` 符号 | 典型 `paid_amount` | `ref_sale_order_id` |
|---|---|---|---|
| 销售单 | 正 | > 0 | NULL |
| 内部单 | 正（半价）| > 0 | NULL |
| 回款单 | 正 | > 0 | 指向原销售单 |
| 转换单 | 正 | ≥ 0（纯卡转换=0）| 指向原销售单 |
| 退款单 | **负** | **< 0** | 指向原销售单 |

关键事实：**退款、回款、转换都是新建单据**，不修改原销售单；靠 `ref_sale_order_id` 关联成"订单链"。

### 1.4 现有支付状态转移触发点

汇总扫描结果（详见 §2.3 触发点图）：

| 文件 | Action | 关键动作 |
|---|---|---|
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | `payNotify` | 微信支付回调 → INSERT payments(首次支付) + 更新 status='已支付' |
| 同上 | `confirmPrepaidFull` | 全额储值卡抵扣确认 → INSERT payments(储值卡) + status='已支付' |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | `create` | 店长开单 + 线下收款 → INSERT payments(首次支付) |
| 同上 | `confirmOffline` | 店长二次确认收款 → INSERT payments + status='已支付' |
| 同上 | `approveRefund` | 审批退款单 → INSERT payments(退款, amount<0) + 原单 paid_amount 累减 |

### 1.5 缺口与遗留

1. **消费发放入口完全空缺**：全仓 grep 无任何订单相关的 `INSERT INTO point_transactions`
2. **cronTask 残留废弃代码**：`fengyu-client/cloudfunctions/cronTask/index.js` 仍在写已删表 `customer_points`（见 L140）。本 ticket 顺手清理
3. **缓存延迟**：`points_balance` 仅凌晨 3 点重算，白天消费后余额当天不变。接入本方案后改为"订单触发实时更新"，cronTask 降级为一致性 checker

---

## 2 目标设计

### 2.1 核心算法：订单链净额差值法

**不能**按 `sale_order_payments` 逐笔 `floor(amount/100)` 独立发放，会产生尾差。

> **反例**：订单 280 元一次付清（期望积分 2），后部分退款 90 元。
> - 分笔法：`floor(280/100) + floor(-90/100) = 2 + (-1) = 1` ← 错（floor(-0.9) = -1，凑巧对）
> - 反例续：订单 280 退 90 再退 50（期望剩 `floor(140/100)=1`）
>   - 分笔：`2 + floor(-90/100) + floor(-50/100) = 2 + (-1) + (-1) = 0` ← **差 1 分**
>   - 净额：`floor(140/100) = 1` ✅

**算法（订单链维度、幂等）**：

```js
// 对"原销售单 id"而非退款/回款/转换单 id
async function settlePointsForOrder(originalSaleOrderId, conn) {
  // 1. 取客户归属
  const { user_id, sale_order_type } = await conn.query(
    `SELECT client_id AS user_id, sale_order_type
       FROM sale_orders WHERE sale_order_id = $1
       FOR UPDATE`,     // 行锁，串行化并发回款/退款
    [originalSaleOrderId]
  );
  if (!user_id) return;                                  // 匿名单不发
  if (!ORDER_TYPES_EARN_POINTS.has(sale_order_type))     // 内部单等跳过
    return;

  // 2. 汇总整条链的"已到账净额"
  const { net_settled } = await conn.query(
    `SELECT COALESCE(SUM(paid_amount), 0)::int AS net_settled
       FROM sale_orders
      WHERE sale_order_id = $1
         OR ref_sale_order_id = $1`,
    [originalSaleOrderId]
  );

  // 3. 目标积分与已发积分
  const expected = Math.floor(Math.max(0, net_settled) / 100);
  const { granted } = await conn.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS granted
       FROM point_transactions
      WHERE ref_order_id = $1`,
    [originalSaleOrderId]
  );

  const delta = expected - granted;
  if (delta === 0) return;  // 天然幂等

  // 4. 写流水 + 更新缓存
  await conn.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id)
     VALUES ($1, $2, $3, $4)`,
    [user_id, delta > 0 ? '消费赠送' : '消费冲销', delta, originalSaleOrderId]
  );
  await conn.query(
    `UPDATE client_wechat_users
        SET points_balance     = points_balance + $1,
            points_updated_at  = NOW()
      WHERE user_id = $2`,
    [delta, user_id]
  );
}
```

三个不变量：
1. 同一订单任意时刻重复调用，`delta=0` 跳过，**无副作用**
2. 订单链净额 ≤ 0 时 `expected=0`，历史发放会被负冲销完
3. 流水 `SUM(amount WHERE ref_order_id = X)` 恒等于 `floor(net_settled/100)`

### 2.2 发放矩阵

| sale_order_type | 调用 settle | 使用的 originalOrderId | 说明 |
|---|---|---|---|
| 销售单 | ✅ | 自身 sale_order_id | 普通消费 |
| 内部单 | ❌ | — | 半价内部消费，不发积分（决策 D1）|
| 回款单 | ✅ | `ref_sale_order_id` | 合并到原销售单重算；自动补发 |
| 转换单 | ✅ | `ref_sale_order_id` | 若 paid_amount>0（补现金差价）则有 delta；纯卡转换 paid=0 无变化 |
| 退款单 | ✅ | `ref_sale_order_id` | 整条链的 SUM(paid_amount) 下降 → delta 为负，自动冲销 |

**核心心智模型**：只认"原销售单"。所有派生单（回款/转换/退款）都是对原单净额的修饰，发积分永远归原单的顾客。

### 2.3 触发点图

```
┌───────────────────────────────┐      ┌──────────────────────────┐
│ clientApi.order.payNotify     │──┐   │ staffApi.order.create    │──┐
├───────────────────────────────┤  │   ├──────────────────────────┤  │
│ clientApi.order.confirmPrepa- │──┤   │ staffApi.order.confirm-  │──┤
│   idFull                      │  │   │   Offline                │  │
└───────────────────────────────┘  │   ├──────────────────────────┤  │
                                   │   │ staffApi.order.approve-  │──┤
                                   │   │   Refund                 │  │
                                   │   └──────────────────────────┘  │
                                   └───────────────┬──────────────────┘
                                                   ▼
                             ┌───────────────────────────────────────┐
                             │ shared/points.js                      │
                             │ settlePointsForOrder(originalId, tx)  │
                             └───────────────────────────────────────┘
                                                   │
                                                   ▼
                             INSERT point_transactions  (+delta)
                             UPDATE client_wechat_users (points_balance)
```

**调用时机**：必须在资金状态写入**之后、事务提交之前**，确保与 payments/sale_orders 的读取落在同一事务快照。

### 2.4 幂等与并发

- **事务内 FOR UPDATE**：对 `sale_orders WHERE sale_order_id = originalId` 加行锁，串行化并发的回款/退款
- **delta=0 天然幂等**：所有触发点安心重跑不会双发
- **advisory lock 备选**：若 FOR UPDATE 不够（如跨云函数调用），用 `pg_advisory_xact_lock(hashtext('pts:' || original_id))`

### 2.5 type 字段约定

不新增枚举，复用 `text` 字段。新增两个取值：

| type 值 | 何时使用 | amount 符号 |
|---|---|---|
| `'消费赠送'` | delta > 0（新增或补发）| + |
| `'消费冲销'` | delta < 0（退款或取消导致回收）| - |

客户端展示：两种 type 已有的 `points.history` 接口自动返回（现状已支持任意 type 透传）。

### 2.6 归属顾客

`sale_orders.client_id` → `client_wechat_users.user_id`（字段已存在）。

**遵循 [client-identity-rule](../../../../.claude/projects/-Users-nv-proj-xt-com-fengyu-wxapp/memory/project_client_identity_rule.md)**：
顾客未绑定微信（`openid IS NULL`）仍可记积分，`points_balance` 正常累加。未来绑微信后顾客端可读。

---

## 3 实现拆解

### PR-A（db + cronTask 清理）

- [ ] `fengyu-client/cloudfunctions/cronTask/index.js` L140 附近：删除对已删表 `customer_points` 的 INSERT
- [ ] 同文件：将"会员升级奖励"发放同步更新 `client_wechat_users.points_balance`（现状不更新，只写流水）
- [ ] 新增 cronTask 步骤："每日校验 points_balance = SUM(流水)"，差异写 operation_logs（仅告警，不自动修）

### PR-B（共享工具函数）

**关键设计**：两端云函数是独立部署单元，不能跨目录 require。采用"复制一份"策略，与现有 `utils/` 模式一致。

- [ ] `fengyu-staff/cloudfunctions/staffApi/utils/points.js` 新建 `settlePointsForOrder(originalId, client)`
- [ ] `fengyu-client/cloudfunctions/clientApi/utils/points.js` 新建同名函数（逻辑一致副本）
- [ ] 两端各补单元测试：
  - 销售单 280 元 → 积分 2
  - 退款 90 元 → 积分变为 1（delta=-1）
  - 再退款 50 元 → 积分变为 1（delta=0）
  - 回款 50 元 → 积分变为 1（delta=0，因为 140+50=190）
  - 纯卡抵扣（paid=0）→ 不写任何流水
  - 内部单 → 不调用函数
  - 幂等重放 10 次 → 只写一条流水

### PR-C（5 个触发点接入）

- [ ] `clientApi/routes/order.js` `payNotify`：在更新订单状态的同事务末尾调用
- [ ] `clientApi/routes/order.js` `confirmPrepaidFull`：同上
- [ ] `staffApi/routes/order.js` `create`：店长现场收款分支末尾调用（用 `ref_sale_order_id ?? sale_order_id` 作参）
- [ ] `staffApi/routes/order.js` `confirmOffline`：同上
- [ ] `staffApi/routes/order.js` `approveRefund`：在 payments(退款) 落账与原单 paid_amount 累减之后调用，参数传原单 id

每个触发点加 try-catch，积分写入失败**不应回滚主事务**（资金状态正确优先），改为写 `operation_logs` 告警，由 cronTask 兜底重算。

### PR-D（admin 展示）

- [ ] `fengyu-admin/src/actions/points.ts` 的筛选枚举新增 `消费赠送`、`消费冲销`
- [ ] `/points` 页表头与汇总卡片自适应（已分组统计正负）
- [ ] `.42cog/pm/backend.pr.spec.md` 新增「积分域」章节（字段语义、发放规则、触发点清单）

---

## 4 验收标准

### 正向发放
- [ ] **AC-01** 顾客下单 280 元（销售单，微信支付全额）→ `point_transactions` 新增 1 条 `('消费赠送', +2, ref=sale_order_id)`；`client_wechat_users.points_balance` +2
- [ ] **AC-02** 同一顾客 3 分钟内下两单（150 + 200）→ 流水 2 条，余额累加 3
- [ ] **AC-03** 店长线下现场收款 199 → 流水 `+1`
- [ ] **AC-04** 店长开单 `confirmOffline` 二次确认 → 恰在确认这一步产生流水（不在 create 时）
- [ ] **AC-05** 全额储值卡抵扣（paid_amount=0）→ 无流水，余额不变

### 冲销场景
- [ ] **AC-06** 销售单 280 → 退款 90 → 流水再追加 `('消费冲销', -1)`；余额 `+2 → +1`
- [ ] **AC-07** AC-06 基础上再退 50（累计 140 元已退）→ 流水不再变化（`floor(140/100)=1`，delta=0）
- [ ] **AC-08** 全额退款 280 → 余额回 0（delta=-1），历史流水保留完整审计
- [ ] **AC-09** 退款金额使链 SUM(paid)≤0 → 积分回 0，**不出现负余额**（`expected = floor(max(0, net_settled) / 100)` 保护，决策 D3）

### 回款与转换
- [ ] **AC-10** 部分预付 100 + 回款补 150（合计 250）→ 原单回款单落账后调用 settle，余额 +2
- [ ] **AC-11** 转换单 paid=0（纯卡转换）→ delta=0，不写流水
- [ ] **AC-12** 转换单 paid=40（补现金差价）且原单已有积分 2 → 链 SUM 变 280+40=320，delta=+1

### 幂等与并发
- [ ] **AC-13** 同一退款审批事件重复触发 settle 5 次 → 流水恰增 1 条
- [ ] **AC-14** 一笔订单同时进行回款+退款（先后提交）→ 用 FOR UPDATE 串行化，最终流水金额正确（可重跑验证）
- [ ] **AC-15** 订单类型=`内部单` → 无论支付多少，无流水

### 数据一致性
- [ ] **AC-16** cronTask 夜间校验：若任何顾客 `points_balance ≠ SUM(流水)` 则写告警，不自动修
- [ ] **AC-17** 已删表 `customer_points` 的写入在 cronTask 被完全移除

---

## 5 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 积分算错 / 实现 bug | 用户余额错误 | 算法幂等可重跑；cronTask 夜间 diff 告警；PR-D 在 admin 留可手工调账入口（未来） |
| 历史订单未回溯 | 上线前的销售单没积分 | **决策 D6 确认不回溯**，上线日作为积分起点，公告老用户；未来如需追溯再立 bootstrap ticket |
| 积分发放失败拖累主事务 | 支付/退款成功但积分没发 → 订单状态不一致 | try-catch 隔离，写 operation_logs，cronTask 兜底重算 |
| 并发回款+退款 | 短时间双写 point_transactions | `FOR UPDATE` + delta=0 幂等 |
| 顾客归属变更 | 很罕见但会造成积分挂错人 | `sale_orders.client_id` 是快照，一旦落单不再变 |
| paid_amount 与 payments 不一致 | 算出的 expected 与真实不符 | settle 内 re-SELECT；PR-A 加 cronTask 不变量校验 |

**回滚策略**：

1. 代码层面：5 个触发点的调用用 feature flag 包裹（环境变量 `POINTS_ACCRUAL_ENABLED=true`），出问题置 false 立即停止发放
2. 数据层面：`point_transactions.type IN ('消费赠送','消费冲销')` 的记录可用一条 SQL 标记撤销（新增负向流水）后余额重算

---

## 6 测试矩阵

| 场景 | net_settled | expected | 预期 delta 序列 |
|---|---:|---:|---|
| 销售单 280 一次付清 | 280 | 2 | `[+2]` |
| 销售单 199 → 退 99 | 100 | 1 | `[+1, 0]` |
| 销售单 280 → 退 90 → 再退 50 | 140 | 1 | `[+2, -1, 0]` |
| 销售单 280 → 全退 | 0 | 0 | `[+2, -2]` |
| 销售单 150 预付 + 回款 130 | 280 | 2 | `[+1(首付), +1(回款)]` |
| 销售单 200 + 回款 100 + 退 50 | 250 | 2 | `[+2, +1, 0]` |
| 纯卡抵扣（paid=0）| 0 | 0 | `[]` |
| 内部单 500 | — | — | `[]`（跳过）|
| 转换单 paid=40 追加在已付 280 的原单 | 320 | 3 | `[+2(原), +1(转换)]` |
| 顾客未绑微信（openid NULL）+ 消费 100 | 100 | 1 | `[+1]`（`user_id` 有值即可）|

算例说明："delta 序列"按时间顺序执行每个动作后 settle 写入的 delta；`0` 表示 settle 被调用但 delta 为 0（不写流水）。

---

## 7 交付物清单

**DB**：
- 无 schema 变更
- 无 migration

**云函数**：
- `fengyu-staff/cloudfunctions/staffApi/utils/points.js`（新增）
- `fengyu-client/cloudfunctions/clientApi/utils/points.js`（新增，逻辑副本）
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js`（3 处调用点）
- `fengyu-client/cloudfunctions/clientApi/routes/order.js`（2 处调用点）
- `fengyu-client/cloudfunctions/cronTask/index.js`（清理废弃 SQL + 新增一致性校验）
- 单元测试：两端各新增 `__tests__/utils/points.test.js`，覆盖测试矩阵全部场景

**前端**：
- 无改动（`pagesProfile/points` 自动显示新 type）

**admin**：
- `fengyu-admin/src/actions/points.ts` 类型枚举扩展
- `fengyu-admin/src/app/(main)/points/` 页面 UI 无感

**文档**：
- `.42cog/pm/backend.pr.spec.md` 新增「积分域」章节（~100 行）

**部署**：
- staffApi / clientApi / cronTask 三个云函数需要 `/cloudbase-deploy`
- 部署完成后手动触发一单验证（AC-01）

---

## 8 业务决策记录（2026-04-24 已确认）

以下 7 项全部按推荐方案定稿，视同本 ticket 的硬约束，AC 与实现必须遵守。

| # | 主题 | 决策 | 含义 |
|---|---|---|---|
| D1 | 内部单是否参与积分 | **不参与** | 发放矩阵中 `sale_order_type='内部单'` 直接 return，无流水（见 §2.2） |
| D2 | 抵扣口径 | **基数 = `paid_amount`** | 券抵扣、卡抵扣均不计入；纯卡抵扣订单 `paid_amount=0` 无积分（充值那笔单会走自己的 settle） |
| D3 | 负余额 | **不允许** | 算法必须用 `expected = floor(max(0, net_settled) / 100)`；历史冲销可把积分降到 0 但不可为负 |
| D4 | 积分兑换（扣减/商城） | **不在本 ticket 范围，暂不另立** | 本 ticket 只管"累加侧"；兑换待需求明确后另议 |
| D5 | 积分过期 | **不在本 ticket 范围，暂不另立** | `point_transactions` 现有字段足够未来加过期策略时兼容，现不预留字段 |
| D6 | 历史订单回溯 | **不回溯** | 上线日为积分起点；老用户通过公告告知；不写 bootstrap 脚本 |
| D7 | cronTask 一致性校验 | **只告警不自动修** | 发现 `points_balance ≠ SUM(流水)` 仅写 `operation_logs`；避免自动修补掩盖上游 bug |

**决策影响点在 AC 中的落位**：
- D1 → AC-15
- D2 → AC-05、AC-11（含 `paid_amount=0` 的无流水用例）
- D3 → AC-09（删除"或允许负余额"的备选表述）
- D6 → §5 风险表「历史订单未回溯」保留为已知约束（不再标注另立 ticket）
- D7 → AC-16

**后续重新讨论的触发条件**：
- D1：若营销/运营提出"内部员工消费积分激励"，需要重新评估 D1
- D4/D5：一旦"积分有什么用"的产品定义出来，立刻启动新 ticket
- D6：若老用户投诉集中，可单独做 bootstrap，但不纳入首期

---

## 9 相关文件快速索引

| 主题 | 路径 |
|---|---|
| 积分流水表定义 | `db/schema/points.ts` |
| 余额缓存字段 | `db/schema/user.ts`（`client_wechat_users.points_balance`）|
| 现有只读 API | `fengyu-client/cloudfunctions/clientApi/routes/points.js` |
| 废弃写入位置 | `fengyu-client/cloudfunctions/cronTask/index.js` L135-L145 |
| 订单资金模型 | `db/schema/order.ts`（`sale_orders`, `sale_order_payments`, `sale_items`）|
| 订单类型枚举 | `db/schema/enums.ts`（`saleOrderTypeEnum`, `paymentChangeTypeEnum`）|
| 客户端支付入口 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` |
| 员工端支付入口 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` |
| 退款工具 | `fengyu-staff/cloudfunctions/staffApi/utils/refund.js` |
| 客户端积分页 | `fengyu-client/miniprogram/pagesProfile/points/` |
| 管理后台 | `fengyu-admin/src/actions/points.ts`、`fengyu-admin/src/app/(main)/points/` |
| 业务规格 | `.42cog/pm/backend.pr.spec.md` §2.8~2.10（订单域）|

---

## 10 建议执行顺序

1. 本 ticket 被业务方审阅，§8 的 7 个开放问题逐一确认
2. PR-A 先落（独立、无依赖、清理债务）
3. PR-B 落，单元测试先行，不接触触发点
4. PR-C 灰度接入：先 `clientApi.payNotify` 一个点上线，观察 1 天无异常再推全量
5. PR-D 最后跟上（纯展示层）
6. 上线 1 周后，根据 cronTask 一致性告警数量决定是否关闭 feature flag 进入稳态
