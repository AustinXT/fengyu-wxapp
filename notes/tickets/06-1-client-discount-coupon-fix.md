# 06-1 clientApi 折扣券分支缺失修复

> **状态**：待执行
> **优先级**：P0
> **创建**：2026-04-10
> **来源**：`notes/adapt-plans/06-coupon-model.md` §4.3 细化
> **关联**：本 ticket 是 06 调研报告中 §4.3 的执行级拆解，修复面比原报告扩大一处孪生 Bug（staffApi SELECT 漏字段）

---

## 0 TL;DR

`fengyu-client/cloudfunctions/clientApi/routes/order.js:291-294` 的折扣券抵扣分支缺失，顾客端下单选中折扣券后 `couponDiscount=0` 但券仍被标记已使用 → **顾客权益被吞**。

进一步摊开代码后发现 **孪生 Bug**：两端 order.js 的 coupon SELECT 子句**都没有取 `ct.max_discount`**，即使报告里的"照抄 staffApi 分支"修复方案被直接采用，封顶分支也会因为字段 undefined 永远不生效 → **公司权益被吞**（店长开单折扣券封顶失效）。

本 ticket 涵盖：
1. 修 clientApi 缺失分支（Bug A）
2. 修两端 SELECT 漏字段（Bug B，孪生，报告未发现）
3. 改写假阳性测试（staffApi 现有折扣券测试靠 mock 塞字段，无法暴露 Bug B）
4. 跑排查 SQL 确定补偿范围

---

## 1 现状定位（基于代码现场）

| 位置 | 现象 | 严重度 |
|---|---|---|
| `fengyu-client/cloudfunctions/clientApi/routes/order.js:291-294` | 只处理现金券/品项券；折扣券落入"空分支"，`couponDiscount` 始终 `0`，但事务内 `UPDATE user_coupons SET status='已使用'` 仍会执行 → 顾客权益被吞 | P0 |
| `fengyu-client/.../routes/order.js:242-244` 的 SELECT | **未选 `ct.max_discount`**。即使补上折扣券分支，若按报告抄 staffApi 写法，依然会使 `couponInfo.max_discount` 恒为 `undefined`，封顶条件恒假 | P0（孪生） |
| `fengyu-staff/.../routes/order.js:281-283` 的 SELECT | **同样漏选 `ct.max_discount`**。`order.js:334-336` 的封顶分支**永远不生效**。销售若配置"8 折最多抵 100"的券，顾客在 1000 元大单上会被抵 200 → 公司权益被吞 | P0（报告未发现） |
| `fengyu-staff/.../__tests__/routes/order.test.js:405-479` 的两个折扣券测试 | 假阳性。测试用 `mockResolvedValueOnce([{ ..., max_discount: '150' }])` 直接塞入字段，绕过了真实 SELECT 字段列表，所以"测试通过"但生产必翻车 | 质量门禁漏洞 |
| `fengyu-client/.../__tests__/routes/order.test.js` | **完全没有** order.create 折扣券相关测试（`grep` 零命中），连假阳性都没有 | 测试缺口 |

报告 §4.3 只点到 Bug A，本 ticket 追加 Bug B 及测试质量问题作为一次性根治。

---

## 2 影响排查 SQL（部署前先跑，确定补偿范围）

### 2.1 clientApi 折扣券被吞（Bug A）

```sql
-- 顾客端下单 + 折扣券 + coupon_discount=0 → 被吞的可疑实例
SELECT
  uc.coupon_id, uc.user_id, uc.used_at, uc.used_sale_order_id,
  ct.name AS template_name, ct.discount_value, ct.max_discount,
  so.total_amount, so.coupon_discount, so.store_id, so.created_at,
  cwu.phone, cwu.name
FROM user_coupons uc
JOIN coupon_templates ct ON ct.template_id = uc.template_id
JOIN sale_orders so      ON so.sale_order_id = uc.used_sale_order_id
LEFT JOIN client_wechat_users cwu ON cwu.user_id = uc.user_id
WHERE uc.status = '已使用'
  AND ct.coupon_type = '折扣券'
  AND so.opened_by IS NULL            -- 关键：顾客自助下单（staff 开单的 opened_by 不为空）
  AND COALESCE(so.coupon_discount, 0) = 0
ORDER BY uc.used_at DESC;
```

**判据**：顾客端下单（`opened_by IS NULL`）+ 折扣券 + `coupon_discount = 0` 必为漏洞吞券记录（折扣券抵 0 只可能是 bug，与无门槛现金券抵完恰好为 0 的合理场景区分）。

### 2.2 staffApi 封顶失效（Bug B，孪生）

```sql
-- 店长开单 + 折扣券 + 带封顶 + 实际折扣超过封顶值 → 公司少收实例
SELECT
  uc.coupon_id, uc.user_id, uc.used_sale_order_id, uc.used_at,
  ct.discount_value, ct.max_discount,
  so.total_amount, so.coupon_discount,
  ROUND((so.total_amount + so.coupon_discount) * (1 - ct.discount_value::numeric), 2)
    AS would_be_discount_without_cap
FROM user_coupons uc
JOIN coupon_templates ct ON ct.template_id = uc.template_id
JOIN sale_orders so      ON so.sale_order_id = uc.used_sale_order_id
WHERE uc.status = '已使用'
  AND ct.coupon_type = '折扣券'
  AND ct.max_discount IS NOT NULL
  AND so.opened_by IS NOT NULL                     -- 员工端开单
  AND so.coupon_discount > ct.max_discount;        -- 实扣 > 封顶 → 封顶没生效
```

> Bug B 的影响方向与 A 相反（多扣 → 公司少收），补偿对象不是顾客。

### 2.3 结果分流

- **排查 = 0 行**：两个 bug 虽然客观存在，但没有产生影响。直接修复 + 测试即可，无需补偿动作。
- **排查 > 0 行**：导出顾客手机号（A 类）/ 订单号（B 类），进入 §5 补偿流程。

### 2.4 排查执行记录（2026-04-10）

**关键发现**：线上存在**两个物理独立的 PG 实例**（cloudbaserc 配置不精确）：

| 实例 | 版本 | 服务对象 | 真实连接（从 `tcb fn detail` 读取） |
|---|---|---|---|
| `47.113.202.7:5434/fengyu` | PG 16.11 Alpine | clientApi | `PG_CONNECTION_STRING` |
| `47.113.202.7:5433/fengyu_wxapp` | PG 16.13 Ubuntu | staffApi | `PG_CONNECTION_STRING` |

> cloudbaserc.json 里 staffApi 写的是 `5434/fengyu_wxapp`——端口错写成 5434 + 库名为 fengyu_wxapp（该组合不存在），线上实际运行环境变量端口是 5433。两处端口错位是遗留配置漂移，非本 ticket 范围，**严禁 `tcb fn deploy --force`** 否则会把坏配置推上去。

#### 两库分别排查结果

| 排查项 | 5434/fengyu（clientApi 库） | 5433/fengyu_wxapp（staffApi 库） |
|---|---|---|
| §2.1 Bug A 吞券 | **0 行** | **0 行** |
| §2.2 Bug B 封顶失效 | **0 行** | **0 行** |

**结论**：走 §2.3 的 = 0 分支，**不执行补偿脚本**。Bug A/B 客观存在但历史未触发（折扣券实际使用量尚未让两个缺陷显形）。直接合并代码 + 部署即可。

---

## 3 修复清单（按文件列 diff，同一轮提交）

### 3.1 clientApi 修复（Bug A + 继承的 Bug B）

**文件**：`fengyu-client/cloudfunctions/clientApi/routes/order.js`

```diff
@@ L241-249 @@
     const couponRows = await pg.query(
       `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
               ct.coupon_type, ct.discount_value, ct.min_spend,
-              ct.applicable_category_ids, ct.applicable_store_ids
+              ct.max_discount,
+              ct.applicable_category_ids, ct.applicable_store_ids
        FROM user_coupons uc
        JOIN coupon_templates ct ON uc.template_id = ct.template_id
        WHERE uc.coupon_id = $1 AND uc.user_id = $2
          AND uc.status = '未使用' AND uc.expire_at > NOW()
          AND ct.is_active = true`,
       [inputCouponId, userId]
     )
@@ L290-294 @@
     // 计算抵扣金额
     if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
       couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
+    } else if (couponInfo.coupon_type === '折扣券') {
+      couponDiscount = eligibleTotal * (1 - Number(couponInfo.discount_value))
+      if (couponInfo.max_discount) {
+        couponDiscount = Math.min(couponDiscount, Number(couponInfo.max_discount))
+      }
     }
     couponDiscount = Math.round(couponDiscount * 100) / 100
```

### 3.2 staffApi 同步修复（Bug B）

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`

```diff
@@ L280-289 @@
     const couponRows = await pg.query(
       `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
               ct.coupon_type, ct.discount_value, ct.min_spend,
-              ct.applicable_category_ids, ct.applicable_store_ids
+              ct.max_discount,
+              ct.applicable_category_ids, ct.applicable_store_ids
        FROM user_coupons uc
        JOIN coupon_templates ct ON uc.template_id = ct.template_id
        WHERE uc.coupon_id = $1 AND uc.user_id = $2
          AND uc.status = '未使用' AND uc.expire_at > NOW()
          AND ct.is_active = true`,
       [inputCouponId, clientUserId]
     )
```

> `order.js:334-336` 的 `if (couponInfo.max_discount)` 代码不动，修完 SELECT 后它会**首次真正生效**。

### 3.3 顺手对齐说明

两个 order.js 都只 SELECT 了 `applicable_store_ids` 而没有 `applicable_market_ids`，后台未来若补 UI 按市场发券，"市场匹配"会被直接忽略。**不在本 P0 范围**，记到 backlog，本次不动以控制改动面。（对应报告 §4.5 应对市场 UI 补齐配套）

---

## 4 测试（重点：把假阳性 mock 改成真断言）

### 4.1 新增 `fengyu-client/.../__tests__/routes/order.test.js` 折扣券用例（目前为 0）

覆盖 4 个场景：

1. **折扣券无封顶**：1000 元 × 8 折 → `couponDiscount=200`，`totalAmount=800`，`user_coupons.status='已使用'`
2. **折扣券带封顶且触发封顶**：1000 元 × 8 折，`max_discount=150` → `couponDiscount=150`，`totalAmount=850`
3. **折扣券带封顶但未触发**：500 元 × 8 折，`max_discount=150` → `couponDiscount=100`
4. **满减不满足（折后）**：500 元、满 600 可用折扣券 → 抛 `INVALID_PARAMS: 未满足使用条件`

### 4.2 对两端折扣券测试增加 SELECT 字段断言（杜绝假阳性复发）

在 `clientApi/__tests__/routes/order.test.js` 和 `staffApi/__tests__/routes/order.test.js` 的折扣券用例末尾增加：

```js
// 断言真实执行的 SELECT 子句包含 max_discount，而不是只靠 mock 返回值塞字段
const couponSelectCall = pg.query.mock.calls.find(
  ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
)
expect(couponSelectCall).toBeDefined()
expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
```

> 这一条是本次修复的"防回归抗体"：即使未来有人重构 SQL 把 `max_discount` 又漏掉，测试会立刻红掉，而不是继续靠 mock 掩盖。

### 4.3 回归

- 两端 `npm test -- routes/order` 需全绿
- 顺手跑一次 `routes/coupon.test`（该文件的 SELECT 本来就正确，应不受影响）

---

## 5 部署与补偿（按 §2 排查结果分流）

### 5.1 部署顺序

1. 先部 **clientApi**（修 A + 继承 B）→ 止损顾客权益被吞
2. 再部 **staffApi**（修 B）→ 止损公司少收
3. 每次走 `cloudbase-deploy` skill，**禁止** `tcb fn deploy --force`；部后人工确认 `PG_CONNECTION_STRING` 等环境变量未被重置（参考 `project_cloudbase_envvar_risk` 风险）

### 5.2 补偿策略

| 排查结果 | 动作 |
|---|---|
| §2.1 = 0 且 §2.2 = 0 | 仅合并代码 + 部署，无需补偿 |
| §2.1 > 0（顾客被吞） | 1) 用 `UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE coupon_id IN (...)` 回滚被吞券；2) 若订单已完成且无法现金补差，另发同面值券；3) 通过小程序 message 通知顾客 |
| §2.2 > 0（公司少收） | 1) 仅登记不追补（上线期问题，不主动向顾客追款，避免信任损伤）；2) 登记到财务差异报表 |

### 5.3 补偿 SQL 脚本落档

- 文件：`db/scripts/backfill/coupon-refund-{YYYYMMDD}.sql`
- 必须先跑排查 SQL 导出 csv → 人工复核 → 再写回滚脚本
- 由**管理后台操作员**执行（不是云函数也不是 admin 后台 Action），走"一次性脚本"流程

---

## 6 变更面 / 风险 / 最小化原则

| 项 | 决定 |
|---|---|
| **改动范围** | 只动 2 个 order.js 的 SELECT + 2 个分支 + 2 个测试文件。**不动** schema、不动 coupon.js（coupon.available 的 SELECT 本来就对）、不动 admin、不动前端 |
| **向后兼容** | 老 `user_coupons` 行 `status='未使用'` 不受影响；历史 `sale_orders` 快照（`coupon_discount` 列）已入库，不回溯 |
| **灰度** | 无需灰度。云函数热更新，clientApi 先部，staffApi 随后。顾客端重试机制不涉及 |
| **回滚** | 若修复后出现新异常，`tcb fn code update` 回退到前一版；`user_coupons` 不会因回滚产生脏数据（事务原子 claim） |
| **与报告 §4.2（满减口径）解耦** | §4.2 满减基数口径问题是另一个独立 P0，**不合并**。理由：Bug A/B 是"纯计算缺失"，必须立刻修；§4.2 涉及前端字段改名 `amount → receivedAmount`，影响面 4 个文件 + 灰度期，节奏不同 |
| **与报告 §4.4（redeem 死代码）解耦** | 死代码，无线上调用，不紧急，后置 |

---

## 7 验收清单（Definition of Done）

- [ ] §2.1 + §2.2 排查 SQL 在 prod 执行完毕，结果录入本 ticket
- [ ] `fengyu-client/.../order.js` 和 `fengyu-staff/.../order.js` 的 diff 已提交，含 SELECT + 分支两处改动
- [ ] `clientApi` 新增 4 个折扣券 `order.create` 用例，`staffApi` 现有折扣券用例追加 SELECT 字段断言
- [ ] 两端 `npm test` 全绿
- [ ] clientApi / staffApi 通过 `cloudbase-deploy` 部署成功
- [ ] 部署后手工回归：顾客端用一张"8 折有封顶"测试券下一单 1000 元 → 实付 850
- [ ] 若 §2 有命中行 → 补偿脚本执行 + 通知发送 + 结果写回本 ticket
- [ ] 报告文档 `notes/adapt-plans/06-coupon-model.md` §4.3 末尾追加"已修复 + 同步修复 staffApi 封顶 SELECT"备注（不修改原分析，仅加 ✅ 注记 + 指向本 ticket）

---

## 8 相关链接

- 上游调研报告：`notes/adapt-plans/06-coupon-model.md` §4.3 / §4.5 / §7
- 参考实现（修复模板）：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:276-356`（折扣券分支的金模板，SELECT 修完后即为完整版）
  - `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:126`（coupon.available SELECT 正确示例，含 `ct.max_discount`）
  - `fengyu-admin/src/lib/utils.ts:37-64`（`calcCouponDiscount` 三券种统一计算）
- 会议依据：`notes/meetings/meeting-20260304/article.md` §八 优惠券体系
