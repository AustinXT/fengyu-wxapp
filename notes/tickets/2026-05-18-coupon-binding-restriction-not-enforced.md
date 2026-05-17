# Ticket: 优惠券绑定限制条件未生效（自动化测试拦截，待定位）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（本周交付项；具体严重度待 Step 1 排查后定级，若涉及资损或越权将升 P0） |
| 端 | fengyu-admin + fengyu-client + fengyu-staff（消费侧） |
| 修复成本 | **M**（Step 1 排查 S；Step 2-3 修复视失效项 M） |
| 来源 | meeting-20260507 §六（夜航星本周交付计划首条） |
| 关联 schema | `db/schema/coupon.ts`（couponTemplates / userCoupons） |
| 关联 archived ticket | `notes/tickets/archives/2026-04-27-coupon-scope-validation.md`（C1-C4 已部分落地）<br>`notes/tickets/archives/1-coupon-template-validity-validation.md`（C8 已落地） |

---

## 0 一句话背景

2026-05-07 周会上夜航星反馈：**优惠券模块仍有 bug——自动化测试发现"绑定限制条件"未生效**，张凯据此拒绝放行手动测试。

**关键模糊点**：会议只说"绑定限制未生效"，没指明是哪一类限制（每人领取上限？单笔订单使用上限？适用品类范围？发放总量上限？满减门槛？……）。

**本 ticket 不直接给"改 X 行"的方案**，而是给一份**"排查 → 定位 → 修复"三阶段流水线**：先跑 admin / client 现有自动化测试套件抓出 FAIL case，反推具体失效项（C1-C8 之一），再按嫌疑清单的修复模板精准修复。

---

## 1 现状（grep 实证）

### 1.1 `couponTemplates` 全部"限制类"字段（db/schema/coupon.ts）

```ts
// 范围限制（NULL = 不限）
applicableProductIds  text('applicable_product_ids').array()
applicableCategoryIds text('applicable_category_ids').array()
applicableStoreIds    text('applicable_store_ids').array()
applicableMarketIds   text('applicable_market_ids').array()

// 数量限制
totalCount   integer('total_count')        // 发放总量上限（NULL=不限量）

// 金额门槛
minSpend     numeric('min_spend')          // 满减门槛（默认 0）
maxDiscount  numeric('max_discount')       // 折扣券封顶

// 有效期
validityMode text('validity_mode')         // 'fixed' / 'days'
validFrom    timestamp('valid_from')
validTo      timestamp('valid_to')
validDays    integer('valid_days')
```

**schema 中没有的限制**：
- ❌ "每人最多领 N 张此券"（per-user cap）
- ❌ "单笔订单最多用 N 张"（per-order cap）
- → 若失效项是这两类之一，需先补 schema 列再补校验逻辑

### 1.2 `userCoupons` 现有索引

```ts
index('idx_user_coupons_user_status').on(userId, status)
uniqueIndex('uq_user_coupons_external_ref')
  .on(externalRef).where(sql`external_ref IS NOT NULL`)
```

`external_ref` 唯一索引仅保证 **cron 派发批次幂等**（`bday-{YYYY}-{userId}-{templateId}`），**不约束**普通 `issueCoupon`/`batchIssueCoupons` 路径下的"同一用户同一模板多次发放"。

### 1.3 已 archived 的两张相关 ticket（避免重复修）

| ticket | 已落地的范围 |
|--------|--------------|
| `2026-04-27-coupon-scope-validation.md` | admin/client/staff 三端 `order.create` 补齐 applicableStoreIds / applicableMarketIds / applicableCategoryIds / applicableProductIds 四维度校验 + face_value_override COALESCE + closeOrder 释放券 |
| `1-coupon-template-validity-validation.md` | admin 端 createTemplate / updateTemplate validityMode (days/fixed) 一致性校验 + issueCoupon 365 天 fallback 已移除 |

→ 本 ticket **不重复**修以上内容；Step 1 必须先**回归验证**两张 archived ticket 的功能仍在线，再进入新失效项排查。

### 1.4 现有发放路径（grep 结果）

| 入口 | 文件 | total_count 校验 | per-user 校验 | externalRef 幂等 |
|------|------|------------------|----------------|------------------|
| admin `issueCoupon` | `fengyu-admin/src/actions/coupons.ts:530-539` | ✅ L532-539 | ❌ 无 | ❌ 不写 |
| admin `batchIssueCoupons` | `coupons.ts:656-664` | ✅ L658-664 | ❌ 无 | ❌ 不写 |
| cron 派发（生日/升级/感恩） | `fengyu-admin/src/cron/steps/*` | 需复核 | 需复核 | ✅ `bday-...` 走 uq 索引 |
| 顾客主动领取 | 当前**无此路径**（client coupon.js 仅 list/available，无 claim/receive） | — | — | — |

→ 如果"绑定限制"指**顾客主动领取限制**，需先确认产品是否计划开放主动领券；当前不存在该入口。

### 1.5 现有消费侧校验（grep 结果）

| 校验项 | admin `createOrder` | client `order.create` | staff `order.create` |
|--------|---------------------|-----------------------|----------------------|
| status='未使用' | ✅ | ✅ | ✅ |
| expireAt > NOW() | ✅ | ✅ | ✅ |
| userId 归属 | ✅ | ✅ | ✅ |
| minSpend | ✅ orders.ts:995-997 | ✅ order.js:363-365 | ✅ order.js:414-416 |
| applicableStoreIds | ✅（archived ticket 已修） | ✅ | ✅ |
| applicableMarketIds | ✅ | ✅ | ✅ |
| applicableCategoryIds | ✅ | ✅ | ✅ |
| applicableProductIds | ✅ | ✅ | ✅ |
| maxDiscount 封顶 | 需 grep 确认 | 需 grep 确认 | 需 grep 确认 |
| 单笔多券互斥 / per-order cap | 未实现 | 未实现 | 未实现 |

---

## 2 修复方案（排查 → 定位 → 修复 三阶段）

### Step 1：定位失效项（必须先做，不要直接动代码）

**目标**：找出夜航星说的"自动化测试发现"具体是哪个 FAIL case，反推业务规则。

执行清单：

1. 跑 admin 优惠券测试套件：
   ```bash
   cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin
   bun run test src/actions/coupons.test.ts
   bun run test src/actions/orders.test.ts -t coupon
   ```
2. 跑 client/staff 云函数测试（如存在）：
   ```bash
   ls /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/cloudfunctions/clientApi/__tests__/coupon* 2>/dev/null
   ls /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/__tests__/coupon* 2>/dev/null
   ```
3. 跑 admin / staff / client e2e 优惠券相关 smoke：
   ```bash
   bun fengyu-admin/tests/e2e-actions/run-all.mjs --filter coupon
   bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter coupon
   ```
4. **回归验证**两张 archived ticket 的 case（C1-C4 / C8）是否仍 PASS——如果回归失败说明是已修功能被回退，按原 ticket 修复路径处理。
5. 若全部 PASS：与夜航星 / 项目组对接，索取"自动化测试发现的 fail case"原始截图或 CI log。

**Step 1 输出物**：在本 ticket 顶部追加 §1.6 小节，列出 FAIL case 的：
- 测试文件 + 测试名
- 断言原文 + 实际值
- 反推业务规则归类到 C1-C8 哪一条

### Step 2：嫌疑清单（按 Step 1 命中项执行；未命中项不动）

| # | 限制项 | schema 字段 | 应在哪里执行 | 现状 | 修复关键点 |
|---|--------|-------------|--------------|------|------------|
| C1 | 适用商品 | `applicable_product_ids` | 三端 `order.create` 下单时校验 `items[].product_id ∈ array` | ✅ archived ticket 已修，需 Step 1 回归 | 若回归失败：恢复 `validateCouponScope` 共享 helper |
| C2 | 适用分类 | `applicable_category_ids` | 同上，按 `sku.category_id` | ✅ 同上 | 同上 |
| C3 | 适用门店 | `applicable_store_ids` | 同上，按 `sale_orders.store_id` | ✅ 同上 | 同上 |
| C4 | 适用市场 | `applicable_market_ids` | 同上，按 `store_id` → market 映射 | ✅ 同上 | 同上 |
| C5 | 发放总量 | `total_count` | 领取/发放时 `(SELECT COUNT(*) FROM user_coupons WHERE template_id=$1) < total_count` | ✅ admin issueCoupon/batchIssueCoupons 已校验；cron 路径需复核 | TOCTOU：用 `SELECT ... FOR UPDATE` 或 advisory lock；批量发放整批回滚 |
| C6 | 满减门槛 | `min_spend` | 下单时校验"scope 内 items 金额合计 >= min_spend"（非全单 totalAmount） | ✅ 三端已校验 | 若失效：基数错（用了 totalAmount 而非 eligibleTotal） |
| C7 | 每人同模板限领 1 张（隐含） | **无字段，业务规则** | 领取/发放时校验 `(SELECT 1 FROM user_coupons WHERE template_id=$1 AND user_id=$2)` 不存在 | ❌ admin issueCoupon/batchIssueCoupons 未校验 | 需先决策：(a) 同模板可多领（无需校验）；(b) 同模板限领 1 张（加 partial UNIQUE 索引 `(template_id, user_id)` + 校验）；(c) 加 schema 列 `per_user_limit INTEGER` 走通用上限 |
| C8 | 有效期 | `valid_from` / `valid_to` / `valid_days` | createTemplate / updateTemplate / issueCoupon | ✅ archived ticket 已修 | Step 1 回归 |
| C9 | 折扣券封顶 | `max_discount` | 折扣计算时 `Math.min(eligible * rate, max_discount)` | 待 grep 确认 | 三端折扣计算分支需统一 |
| C10 | 单笔订单券数上限 | **无字段，业务规则** | `order.create` 校验 `couponIds.length <= N` | 未实现，当前默认单笔最多 1 张？需确认产品意图 | 若产品要求支持多券：加 schema 列 `per_order_cap` |

### Step 3：修复模板（每条 Cx 都套这个模板）

对 Step 1 命中的 Cx，按下面顺序操作：

1. **grep 定位**：`grep -rn "<关键字段>" db/ fengyu-admin/src/actions fengyu-client/cloudfunctions fengyu-staff/cloudfunctions`
2. **写测试先（红）**：在对应测试文件加 1 个 `it('应拒绝违反 Cx 的请求')`，跑测试确认 FAIL
3. **改代码（绿）**：按现状矩阵补 SQL SELECT 字段 + JS 校验分支
4. **跨端同步**（如改 admin + client/staff 共用的优惠券 SQL）：
   - 改一端 → 同步其它两端 → 跑 `cross-end-sql-snapshot.test.js` 和 `cross-end-error-codes-snapshot.test.js` 守护
   - error code 统一用白名单前缀（推荐 `INVALID_PARAMS:` 或 `INVALID_STATE: COUPON_RESTRICTION:`，参考 CLAUDE.md 二级前缀语法）
5. **cron 派发路径例外**（若 Step 1 命中 C5/C7）：
   - cron 内部走 service-role 路径（生日/升级/感恩日派发）可能需要 bypass per-user-cap，仅校验 totalCount
   - 实现时区分入参：`issueCoupon({ source: 'manual' | 'cron', ... })`，cron 路径 skip per-user 校验
   - 参考 `feedback_no_legacy_compat.md`：开发阶段不需要保留 fallback，cron 直接走分支即可

### Step 4：(可选) Step 1 找不到 FAIL case 时

若跑遍所有测试套件全 PASS，仍要兜底排查：
- 主动新增"绑定限制"覆盖测试矩阵（C1-C10 各 1 case，跨 admin + client + staff = 30 case）
- 跑覆盖率：`bun run test --coverage` 看 coupon 相关分支覆盖率，找未覆盖的限制分支
- 与夜航星同步排查结果，必要时升级到 CI log 调取

---

## 3 验收标准（DoD）

### Step 1（排查）
- [ ] admin/client/staff 三端优惠券相关测试套件全部跑过，FAIL case 列表落到本 ticket §1.6
- [ ] 回归两张 archived ticket（2026-04-27-coupon-scope-validation / 1-coupon-template-validity-validation）功能仍 PASS
- [ ] 失效项明确归类为 C1-C10 中的某一项（或多项），写入 commit message 与本 ticket §1.6

### Step 2-3（修复）
- [ ] Step 1 定位的 Cx 测试 case：先红后绿
- [ ] 新增 1 条 e2e 集成测试：模拟"违反 Cx 的下单/领取请求" → 期望被拒（error code 走 9 项白名单前缀）
- [ ] 若改了 admin + client/staff 共用 SQL：`cross-end-sql-snapshot.test.js` + `cross-end-error-codes-snapshot.test.js` 跑通
- [ ] 若涉及 schema 变更（C7 / C10 新增列）：drizzle migration 在 5434 跑过；`cd fengyu-admin && npx tsc --noEmit` 零新增错误
- [ ] cron 派发路径独立验证：生日/升级/感恩日派发 case 跑过，未被新限制误拒
- [ ] 手动测试解锁：与张凯沟通，确认优惠券模块可进入手动测试阶段（meeting-20260507 §六前提）

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| **方向错**：修了 C1 实际失效是 C5，浪费一轮 | Step 1 强制先跑测试定位，不允许跳过 |
| **重复修**：两张 archived ticket 已处理 C1-C4 / C8，本次再改一遍 | Step 1 回归验证必做；修复前先 grep 确认现状 |
| **cron 误拒**：补 C7（per-user 限领 1）后，cron 给同一顾客年生日券 + 升档券同模板被拒 | 区分 `source='manual'/'cron'`；cron 路径 skip per-user 校验，仅校验 totalCount + externalRef 幂等 |
| **C5 TOCTOU**：两人同时点 issueCoupon 都过了 count 校验 | 用 `SELECT count(*) ... FOR UPDATE`（template_id 行锁）或加 partial UNIQUE 索引（C7 同样适用） |
| **schema 新列影响 admin 表单**：C7/C10 加列后 admin coupon 创建/编辑页需补字段 | 同 PR 内补 admin UI；前端 zod schema 同步加可选字段 |
| **error code 漂移**：新增 `INVALID_STATE: COUPON_RESTRICTION: ...` 未走白名单 | 一级前缀仍走 9 项白名单（INVALID_STATE / INVALID_PARAMS / PERMISSION_DENIED / NOT_FOUND）；二级标签 `[A-Z_]+` 仅日志归类，参考 `fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js` |

**回滚**：
- 若仅是消费侧 JS 校验补丁：commit revert 即可
- 若加了 schema 列（C7/C10）：列设为 nullable，drop column 安全
- 若改了共享 helper：保持各端独立副本，回滚一端不影响其它端（参考 `feedback_no_shared_cloudfunctions.md`）

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260507/article.md` §六（夜航星本周交付计划首条："修 bug 包括优惠券绑定限制"） |
| 关联 schema | `db/schema/coupon.ts`（couponTemplates / userCoupons） |
| 关联 archived ticket | `notes/tickets/archives/2026-04-27-coupon-scope-validation.md`（C1-C4 落地，本次回归）<br>`notes/tickets/archives/1-coupon-template-validity-validation.md`（C8 落地，本次回归） |
| 关联 cron | `fengyu-admin/src/cron/steps/`（生日 / 升级 / 感恩日派发，C5/C7 修复时需独立验证不被误拒） |
| 关联 error code | `fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js` 等三端副本 + `fengyu-admin/src/lib/api-error.ts`（白名单前缀单源） |
| 关联 snapshot 测试 | `cross-end-sql-snapshot.test.js` + `cross-end-error-codes-snapshot.test.js`（共享 SQL/错误码守卫） |
| 关联 feedback | `feedback_no_legacy_compat.md`（不保留 fallback）<br>`feedback_no_shared_cloudfunctions.md`（三端独立副本 + snapshot 守卫） |
| 关联 spec | 修复后视情况更新 `.42cog/pm/backend.pr.spec.md` §coupon 小节（若新增 C7/C10 schema 列） |
| 后续手动测试 | Step 3 完成后通知张凯解锁优惠券模块手动测试 |
