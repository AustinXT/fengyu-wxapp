# fengyu-staff E2E 运行报告 — 2026-06-08

承接 `RUN-REPORT-2026-05-28.md`。本轮**只运行不改源码**（按用户决策：先全跑出报告再决策）。全量跑了 L2 云函数 + L3 小程序（smoke + scenarios）三层。

## 一句话结论

- **L2 云函数**：60/64 PASS。4 个失败**全部非新回归**（1 flaky + 2 测试漂移 + 1 已知数据问题）。
- **L3 小程序 Smoke**：10/10 PASS（1 处软警告）。
- **L3 小程序 Scenarios**：10/12 PASS。2 个失败均为**测试侧问题**（1 测试基建 bug + 1 潜伏 fixture 问题首次暴露），无产品回归；且 300s 硬挂已消失、bs06 较基线由 FAIL 转 PASS。

无任何确证的**产品功能回归**。下方「待决策清单」列出 5 项建议修复。

---

## 运行环境

| 项 | 值 |
|----|----|
| 日期 | 2026-06-08 |
| bun | 1.3.13 |
| PG | `47.113.202.7:5434/fengyu`（生产业务库，命名空间隔离） |
| IDE | 微信开发者工具，`run-staff-l3.sh` 自动接管（client→staff→跑→切回 client） |
| 并发干扰 | 运行 L2 期间有**另一会话在跑 client E2E**（同 PG），加剧了连接池超时型 flaky（见 L2-①） |

---

## L2 云函数（`e2e-cloudfn/run-all.mjs`）

**结果：60 PASS / 64 total，794s。** 4 FAIL 明细：

| 失败 smoke | 隔离复跑 | 判定 | 根因 |
|------------|---------|------|------|
| `smoke-mgmt-dashboard` | ✅ **PASS** (15/15) | **① flaky（基础设施）** | `scopeOptions` 返回 code=-1（PG 连接池首调超时）。并发 client run 抢占连接池所致；隔离复跑即过。**非回归。** |
| `smoke-service-commission` | ❌ 隔离仍 FAIL | **② 已知数据问题（疑似产品 bug）** | CASE1 rate 应 0.10 实际 0.15、CASE2 应 0.12 实际 0.15、CASE4 应 0 实际 0.02。`commission_rate_matrix` 被非测试市场规则污染，`routes/service.js` 提成率 SELECT **不按 org 过滤** → 命中别市场更高 rate。05-28 已记录为 follow-up。 |
| `smoke-order-create-internal` | ❌ 稳定复现 | **③ 测试漂移** | 断言 `unit_price=400`（旧模型）。现金额模型下 `unit_price=800`（标价快照，order.js:685「标价行总额/session_count」），5 折成交价落在 `unit_real_price=400`/`sale_amount=400`，`totalAmount=400` 均正确。产品行为对，断言过时。 |
| `smoke-order-deposit` | ❌ 稳定复现 | **④ 测试漂移（今日新引入）** | lock 断言要求寄存单退款消息含 `/寄存单/`，实际返回 `INVALID_STATE: 仅销售单支持退款`。今日提交 `78b268b8`（退款 Bug-L 正向白名单）+ `92f00954`（移除寄存单收款回执）改了消息，断言正则没跟。退款**仍被正确拒绝**（errorType=INVALID_STATE），仅文案变化。 |

> 已知 flaky 名单中的 `smoke-mgmt-traffic` / `smoke-rbac-hq-level` / `smoke-alloc-suggest` 本轮**均 PASS**。

---

## L3 小程序 Smoke（`run-staff-l3.sh` → `run-all.mjs`）

**结果：10/10 PASS。** IDE 自动接管成功（探测到当前是 client → 切 staff → 跑 → 切回 client）。

| smoke | 结果 | 备注 |
|-------|------|------|
| allocation-save / appt-to-service / conversion-order / refund-approve / service-lifecycle | ✅ PASS | 仅验 UI 加载阶段（深度交互 TODO，由 scenarios 覆盖） |
| confirm-offline | ✅ PASS | 全链路：fixture→login→confirmOffline→PG 状态+payments 行断言 |
| create-sales-order / login-tab / workbench-render / customer-360 | ✅ PASS | login-tab 验 5 个 Tab 页挂载；workbench 验 todayCommission |

**软警告（非致命，仍 PASS）**：`smoke-staff-customer-360` 的 `customer.name` 期望含「L3 测试顾客」实际为空（列表渲染时点 name 字段未及填充；direct API detail 字段正常）。

---

## L3 小程序 Scenarios（`run-staff-l3.sh --scenarios`）

**结果：10 PASS / 2 FAIL / 12 total，231s。无硬挂。**

| 场景 | 结果 | 耗时 |
|------|------|------|
| bs01-order-flow | ❌ **FAIL** | 9.1s |
| bs02-refund-approve | ❌ **FAIL** | 8.8s |
| bs03-service-lifecycle | ✅ PASS | 15.8s |
| bs04-allocation | ✅ PASS | 26.5s |
| bs05-appt-to-service | ✅ PASS | 11.5s |
| bs06-role-visibility | ✅ PASS（12 条矩阵全过） | 69.5s |
| bs07-customer-assign | ✅ PASS | 10.3s |
| bs08-conversion-panel | ✅ PASS | 11.6s |
| bs09-card-recharge | ✅ PASS | 11.7s |
| bs10-mgmt-scope-options | ✅ PASS | 26.0s |
| bs11-multi-store-switch | ✅ PASS | 15.0s |
| bs12-cross-store-deny | ✅ PASS | 15.4s |

### 2 个失败明细（均测试侧，非产品回归）

**bs01-order-flow → ⑤ 潜伏 fixture/shopInit 契约问题（首次暴露，非新回归）**
- `step2_assertDefaultKind`（spec:125）：「普通商品 Tab 下 categories 为空」。
- `product.shopInit` 的 categories 查询需要一级父行（`category_name='普通商品' AND product_kind IS NULL`）与二级行 `product_kind='普通商品'` 匹配（product.js:68-69），bs01 fixture 大概率缺这层一级行或缺合格 SKU。
- **关键**：05-28 时 bs01 被 `SKIP_FLAKY`（step1 300s 硬挂，step2 从未跑过）。本轮硬挂消失、step1 9s 通过，step2 第一次真正执行才暴露此 fixture 缺口。**不是本周期新引入的回归。**

**bs02-refund-approve → ⑥ 测试基建 bug（相对 05-28 退化，1 行可修）**
- step2（loginAs B 后）automator 报 `parameter error: parameter.url should be String instead of Object`。
- 根因：`bs02-refund-approve.spec.mjs:126` 写成 `miniProgram.reLaunch({ url: '/pages/workbench/workbench' })` —— 给 **automator** 的 `reLaunch` 传了 **wx 风格对象 `{url}`**，但 automator API 要的是**字符串**：`miniProgram.reLaunch('/pages/workbench/workbench')`。
- 这是 05-28「F1 修复」把 navigateToTab 换成 reLaunch 时误用了 wx 的对象签名。前半段（createRefund + PG 断言「退款/待审批/-800」）全部正确，仅卡在导航调用。

---

## 与 2026-05-28 基线 diff

| 项 | 05-28 | 06-08 | 变化 |
|----|-------|-------|------|
| L2 总数 | 64 | 64 | — |
| bs06-role-visibility | ❌ FAIL（文案不匹配） | ✅ **PASS**（12/12） | **改善** ✅ |
| bs01-order-flow | ⏭ SKIP_FLAKY（300s 硬挂） | ❌ FAIL（9s，categories 空） | 硬挂消失，潜伏 fixture 问题首次暴露 |
| bs02-refund-approve | ✅ PASS | ❌ FAIL（reLaunch url 对象） | **退化**（测试基建，非产品） |
| order-create-internal / order-deposit | 未在基线明确列出 | ❌ FAIL（测试漂移） | order-deposit 是今日提交引入的漂移 |
| service-commission / mgmt-dashboard | ⚠️ 已记录漂移/抖动 | 同（mgmt-dashboard 隔离 PASS） | 维持 |

---

## 本轮决策与修复（2026-06-08）

用户拍板：修测试侧 4 项（⑥④③⑤）；② 先查生产库再决定。

| # | 项 | 修法 | 文件 | 验证 |
|---|----|------|------|------|
| ⑥ | bs02 reLaunch 对象参数 | `reLaunch({url})` → `reLaunch('...')`（automator 入参是字符串） | `scenarios/bs02-refund-approve.spec.mjs:126` | ✅ **PASS**（全链路含 workbench 徽章联动） |
| ④ | order-deposit 退款消息断言 | lock 断言 `/寄存单/` → `/仅销售单支持退款/`（对齐 Bug-L 白名单；errorType 仍 INVALID_STATE） | `smoke-order-deposit.mjs` 6a | ✅ PASS |
| ③ | order-create-internal unit_price 断言 | 改断言 `unit_real_price===400` + `unit_price===800`（标价快照模型） | `smoke-order-create-internal.mjs` | ✅ PASS |
| ⑤ | bs01 普通商品类目空（+ 连带 step2/step6 字段漂移） | ①fixture 补一级父类目行（`product_kind=NULL`，命名空间 kind `L3护理项目`）+ 二级行 product_kind 对齐；②step2 断言由 `d.categories`（普通商品 Tab 恒为 `[]`）改查 `d.groupedCategories` 含 L3 + 加 `waitForData` 等异步加载；③step6 选顾客匹配键 `customerInfo.id`（=customer_id，测试顾客为 null）→ `customerInfo.clientUserId`（=user_id） | `scenarios/bs01-order-flow.spec.mjs` | ⚠️ **部分**（见下） |

> ⑤ 多根因（之前 05-28 因 bs01 step1 300s 硬挂被 SKIP，step2 起从未真正跑过，逐步暴露）：
> (a) fixture 用了**生产已不存在的 product_kind「护理项目」**，shopInit 的 `withParentJoin` INNER JOIN（`parent.category_name=child.product_kind`）找不到一级父行 → 类目被丢弃。生产实际 kind 是 `招牌/王牌/明星/加项/家居/其他/拓客引流卡`（DB 驱动）。
> (b) order-create.ts 的「普通商品」Tab 用 `groupedCategories` 渲染，`categories` 恒为 `[]`，旧断言查错了字段。
> (c) step6 选顾客匹配键用错（`.id` vs `.clientUserId`）。
>
> **修复已验证正确**：DB 层跑 shopInit 等价查询（withParentJoin+EXISTS）返回 **6 组含 L3护理项目**；某次热 IDE 运行 bs01 step2 PASS（`groupedCategories=6 已含 L3`）且 step3/4/5 通过（`cartTotal=2100`）。
>
> **但 bs01 端到端仍未跑绿**，卡在**远程 dev staffApi 的 `product.shopInit` 间歇返回空 groupedCategories**（`groups=0, catalogLoading=false`，被页面 `loadShopInit` try/catch 吞成空数据）：
> - 同一份 fixture + 同一份 DB，本地 require 的 L2 `smoke-product-shopinit` **PASS**、DB 等价查询返回 6 组 → 数据与代码逻辑正确；
> - 多次重启后远程 shopInit 持续 0 组（连生产 6 组都没有）→ 属**云函数侧 PG 连接池冷启/抖动 flaky**（与 ① mgmt-dashboard 同类，今日 5434 多次抖动）；
> - 另：bs01 重跑若不重启 IDE 会有**购物车 data 跨次泄漏**（step3 badge=3），是 harness 重跑假象（全套跑时 IDE 全新启动无此问题）。
> - **结论**：⑤ 的数据/字段修复均正确且为净改进（把 bs01 从「step2 必挂」推进到「step5 通过」），但 bs01 完整跑绿被远程 shopInit flaky 阻塞，且 step7-9 仍未验证 → **建议另起 bs01 专项稳定化**（含 shopInit 空结果重试兜底），超出本轮「补一级类目」范畴。

### ② service-commission 提成率未按 org 过滤 — 生产库核查结论

只读查询生产 `commission_rate_matrix`：

```
总行数 = 14，org 数 = 1
跨 org 同 (order_type, role_type, sales_category, tier_min) 多 rate 的组 = 0 行
```

**结论：生产环境无跨市场污染，提成率计算线上正确（单 org 无歧义）。** 测试里出现的 0.15 是 fixture 造的第 2 个 test org 规则，被 `routes/service.js` 不带 org 过滤的 SELECT 跨 org 取到。

- **今天不是生产 bug**，无需急修。
- 残留：① service.js 提成率 SELECT 不带 `org_id` 过滤是**潜在隐患**（未来真上线第 2 个 market 才会触发跨 org 取错率）；② service-commission smoke 的 fixture 隔离 gap。两者按 follow-up 处理（低优先级硬化项），用户暂未要求修。

### ① mgmt-dashboard

基础设施 flaky（PG 连接池首调超时，隔离复跑 15/15 PASS），无需修。建议：**L2 跑测时避免与 client E2E 并发**（本轮并发是超时主因）。

---

## 复现命令

```bash
# L2 全套
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs
# 单独复核 4 个 L2 失败
for s in smoke-order-create-internal smoke-order-deposit smoke-mgmt-dashboard smoke-service-commission; do
  bun fengyu-staff/tests/e2e-cloudfn/$s.mjs
done

# L3 smoke + scenarios（自动接管 IDE）
./fengyu-staff/tests/run-staff-l3.sh
./fengyu-staff/tests/run-staff-l3.sh --scenarios

# 失败日志 / 截图
ls fengyu-staff/tests/e2e-cloudfn/test-results/*.log
ls fengyu-staff/tests/e2e-miniprogram/test-results/{*.scenario.log,screenshots/}
```
