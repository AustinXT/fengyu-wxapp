# 06-2 clientApi coupon.redeem 引用 4 个不存在列（线上崩溃，非死代码）

> **状态**：待执行
> **优先级**：P0（线上可触发 SQL 崩溃）
> **创建**：2026-04-10
> **来源**：`notes/adapt-plans/06-coupon-model.md` §4.4 细化
> **关联**：06 调研报告把本问题定性为 "P1 死代码"。本 ticket 推翻该前提——前端实际有 UI 调用，需按 P0 处理；并套用 06-1 ticket 的"防假阳性测试"同款整改模式。

---

## 0 TL;DR

`fengyu-client/cloudfunctions/clientApi/routes/coupon.js` 的 `redeem` 函数在一条 SELECT 里引用了 **4 个 `coupon_templates` 根本不存在的列**——任意一次调用即 `column "redeem_code" does not exist` 500；更隐蔽的是函数末尾 `pg.transaction` 内还有一条 `UPDATE ... SET claimed_count = claimed_count + 1`，同样打在不存在的列上。

**与报告 §4.4 的关键分歧**：报告结论是"前端无调用 → 死代码 → 直接删函数即可"。实际情况是 `fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxml:9-28` 有可见的"输入兑换码 + 兑换"按钮，`my-coupons.ts:75` 在调用 `coupon.redeem`。**这是线上崩溃，不是死代码**。顾客打开"我的优惠券"页、键入任意字符、点击兑换 → Toast "兑换失败"（失败消息来自 `sanitizeErrorMessage` 兜底）。

外加两处副作用需要顺手清掉：

1. `fengyu-client/cloudfunctions/clientApi/__tests__/routes/coupon.test.js:211-370` 的 11 个 redeem 用例全部**假阳性通过**——通过 `pg.query.mockResolvedValueOnce([{ ..., max_claims, claimed_count, template_expire_at }])` 直接往 mock 返回值里塞不存在的列，绕过真实 SELECT 字段列表。这与 06-1 ticket 中 Bug B 的问题同构（mock 掩盖 SELECT 缺字段），**也要打防回归抗体**。
2. 路由表 + 两个 CLAUDE.md + 小程序前端两个文件 + 一个 `index.js` 路由注册都要同步处理，影响面 8 个文件。

---

## 1 现状定位（代码现场）

### 1.1 缺失列清单（云函数侧）

**文件**：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js`

| # | 列 | 引用位置 | Schema 现状 | 说明 |
|---|---|---|---|---|
| 1 | `redeem_code` | L231 `WHERE redeem_code = $1` | ❌ 不存在 | 兑换码机制从未在 `db/schema/coupon.ts` 落地；grep `db/schema/` 0 命中；admin 无创建入口 |
| 2 | `expire_at`（模板级） | L228 `expire_at AS template_expire_at` | ❌ 不存在 | 模板级到期在 schema 中由 `valid_from`/`valid_to`（fixed 模式）+ `valid_days`（days 模式）表达 |
| 3 | `max_claims` | L228 | ❌ 不存在 | 领取总量在 schema 中是 `total_count integer`（L21-22 schema 注释："发放总量限制（null=不限量）"） |
| 4 | `claimed_count` | L228 SELECT 和 L287 UPDATE | ❌ 不存在 | 根本没有"已领取计数"列；设计意图是从 `user_coupons` 聚合 `COUNT(*) WHERE template_id = ...` 得到 |

> ⚠️ **别只盯 SELECT**：L287 `UPDATE coupon_templates SET claimed_count = claimed_count + 1` 同样会炸。即便 SELECT 被修好，事务第二句仍会在 `pg.transaction` 内抛 `column "claimed_count" does not exist`，整个事务 rollback，用户券和计数一起丢。

**触发的 SQL 异常链**：

1. 前端调用 `coupon.redeem({ code: 'ANY' })`
2. `requirePhone` 通过（已绑手机号的正常用户）
3. 走到 L225-233 SELECT → PG 抛 `column "redeem_code" does not exist`
4. 云函数 500，`sanitizeErrorMessage` 转成"兑换失败"
5. 顾客看到 Toast 失败 → 无法判断是"码错了"还是"功能坏了" → 客诉

### 1.2 假阳性测试（同 06-1 Bug B 模式）

**文件**：`fengyu-client/cloudfunctions/clientApi/__tests__/routes/coupon.test.js:211-370`

```js
// L213-228 —— mock 里塞了 3 个不存在的列，测试永远绿，生产必崩
const validTemplate = {
  template_id: 'tpl-1',
  name: '新人专享券',
  coupon_type: '现金券',
  discount_value: 20,
  min_spend: 0,
  max_discount: null,
  applicable_category_ids: null,
  applicable_store_ids: null,
  valid_days: 30,
  template_expire_at: null,   // ← 不存在的列
  max_claims: null,            // ← 不存在的列
  claimed_count: 0,            // ← 不存在的列
  description: '新用户专属',
  is_active: true,
}

// L231-251 正常流用例：pg.query.mockResolvedValueOnce([validTemplate])
// → SELECT 的 SQL 字符串从未被校验，mock 直接返回构造的对象，测试通过
```

这与 06-1 ticket §1 "staffApi 假阳性测试"完全同构：mock 把真实 SQL 字段列表绕过去了。该文件有 11 个 redeem 用例，**全部** 假阳性。

### 1.3 报告 §4.4 前提的反证（前端实际在调用）

| 文件 | 行号 | 内容 |
|---|---|---|
| `fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxml` | 9-28 | `<view class="redeem-section">` 输入框 + `<van-button bindtap="onRedeem">兑换</van-button>` |
| `fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.ts` | 65-84 | `onRedeem` 方法，`await callClientApi('coupon.redeem', { code })` |
| `fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxss` | 8-37 | `.redeem-section` / `.redeem-row` / `.redeem-input` / `.redeem-btn` 样式 |
| `fengyu-client/cloudfunctions/clientApi/index.js` | 49 | `'coupon.redeem': () => require('./routes/coupon').redeem` |
| `fengyu-client/CLAUDE.md` | 32 | 路由表列出 `redeem` |
| `fengyu-client/cloudfunctions/clientApi/CLAUDE.md` | 26 | 接口列表列出 `redeem` |

**结论**：报告 §4.4 写于 `grep 'coupon.redeem'` 发现"只有 index.js + test + CLAUDE.md"的时点，**漏扫了 `pagesCoupon/my-coupons/`**（分包路径）。今日重跑 grep 可见 4 个前端命中位置。

---

## 2 线上影响排查 SQL（部署前先跑）

### 2.1 是否已经有顾客踩过坑

云函数本身不会在 `coupon_templates` 留痕（事务内 rollback 不影响计数），但可以用以下信号估计曝光面：

```sql
-- 统计"我的优惠券"页面活跃用户数（近 30 天有券、有登录）
SELECT COUNT(DISTINCT uc.user_id) AS exposed_users
FROM user_coupons uc
WHERE uc.expire_at > NOW() - INTERVAL '30 days';
```

```sql
-- 若接入了前端错误上报平台（sentry / wx.reportMonitor / callClientApi 的 sanitizeErrorMessage 日志）
-- 可去翻 "coupon.redeem" 相关的 500 堆栈
-- 如无错误上报渠道，跳过此条
```

> 这不是精确计数（只统计暴露面），但能判断"是否需要主动通知"。若 `exposed_users > 0`，进入 §5.2 策略。

### 2.2 是否有顾客通过其他路径（admin 手动发放）已经得到券

与本 bug 无关，但因为同属 06 报告范围，顺带确认"删除 redeem 后顾客仍能通过 admin `issueCoupon` / `batchIssueCoupons` 拿到券"。

```sql
SELECT issuer_type, COUNT(*)
FROM user_coupons
GROUP BY 1;
-- 预期：admin 发放 / 系统发放占绝大多数，redeem 兑换为 0（因为本来就崩）
-- 实际 schema 没有 issuer_type 列时跳过此查，作为"删 redeem 无业务损失"的心证即可
```

---

## 3 决策：方案 A（删除） vs 方案 B（补 schema）

### 3.1 方案 A — 删除 redeem 全链路（推荐）

**理由**：

1. `notes/meetings/` 搜不到"兑换码"需求（2026-03-04 会议 §八优惠券 只说"按分类/门店/市场/时段，按手机号发放"）
2. admin UI 无兑换码管理入口（`fengyu-admin/src/app/(main)/coupons/` 三个 \_components 文件均无 `redeemCode` 字段）
3. 业务上兑换码场景被"按手机号批量发放"取代（`admin/src/actions/coupons.ts` 的 `batchIssueCoupons`）
4. 06 报告 §4.4 结论也是"方案 A（推荐）：删除"

**改动面**：8 个文件，纯删。

### 3.2 方案 B — 补 schema + admin 入口 + 前端联调

**需要做的**：

- 迁移：加 `coupon_templates.redeem_code TEXT UNIQUE`、`total_count` 已存在，把 `max_claims` 概念映射到现有 `total_count`；`claimed_count` 改为 `(SELECT COUNT(*) FROM user_coupons WHERE template_id = ...)` 聚合查询；`template_expire_at` 改用 `valid_to`
- admin：创建券模板时增加"生成/输入兑换码"字段
- 前端：`my-coupons` 页面保留，但补提示文案
- 云函数：把 `redeem` 的 4 列全部改名/聚合
- 新增测试，且要补"SELECT 子句包含 `redeem_code`"的断言

**反对理由**：

- 无明确业务需求（会议记录未提兑换码），做出来也没人用
- 迁移 + admin + 前端 + 云函数 + 测试，至少 5 处代码面
- 迁移涉及 `coupon_templates` 结构，一旦上线难以回退

### 3.3 决策

**选方案 A**。下列清单按方案 A 展开；若业务后续需要兑换码，再独立开 ticket 走方案 B。

---

## 4 修复清单（方案 A，8 个文件）

### 4.1 云函数删除

**文件 1**：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js`

```diff
-/**
- * 兑换优惠券
- * payload: { code: string }
- */
-async function redeem(ctx) {
-  await requirePhone()(ctx, async () => {})
-
-  const { userId } = ctx.auth
-  const { code } = ctx.event.payload || {}
-  ...
-  ctx.result = {
-    couponId,
-    name: tpl.name,
-    couponType: tpl.coupon_type,
-    discountValue: tpl.discount_value,
-    expireAt,
-  }
-}
-
-module.exports = { list, available, redeem }
+module.exports = { list, available }
```

（整段 L208-299 的 `redeem` 函数删除；L301 `module.exports` 去掉 `redeem`）

**文件 2**：`fengyu-client/cloudfunctions/clientApi/index.js`

```diff
   'coupon.list': () => require('./routes/coupon').list,
   'coupon.available': () => require('./routes/coupon').available,
-  'coupon.redeem': () => require('./routes/coupon').redeem,
   'points.balance': () => require('./routes/points').balance,
```

（L49 一行）

### 4.2 测试清理

**文件 3**：`fengyu-client/cloudfunctions/clientApi/__tests__/routes/coupon.test.js`

```diff
-describe('coupon.redeem', () => {
-  ...
-  test('无手机号 → PHONE_REQUIRED', async () => {
-    const ctx = createCtx({ payload: { code: 'TEST' }, auth: { phone: null } })
-    await expect(routes.redeem(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
-  })
-})
```

删除 L211-370 整个 `describe('coupon.redeem')` 块及其 11 个 `test(...)` 用例。

同时修改文件头部注释：

```diff
-/**
- * 覆盖：list（过期懒清理）、available（store/category 匹配、折扣计算）、redeem（兑换码全路径）
- */
+/**
+ * 覆盖：list（过期懒清理）、available（store/category 匹配、折扣计算）
+ */
```

### 4.3 防假阳性抗体（新增，非删除）

在文件剩余的 `coupon.list` 和 `coupon.available` 用例末尾各加一条 SELECT 字段真实性断言——**不针对本次删除，而是防止未来同类假阳性再发生**。参考 06-1 ticket §4.2 的"防回归抗体"思路。

```js
// 放在 list / available 各自 describe 块的顶部 test 里
test('SELECT 真实包含 schema 存在的列（防假阳性 mock）', () => {
  // 捕获最近一次 coupon_templates JOIN 调用
  const call = pg.query.mock.calls.find(
    ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
  )
  expect(call).toBeDefined()
  // 这些列必须真实出现在 SELECT 中（否则未来再次出现"mock 塞字段 → 假绿"问题）
  expect(call[0]).toMatch(/ct\.coupon_type/)
  expect(call[0]).toMatch(/ct\.discount_value/)
  expect(call[0]).toMatch(/ct\.min_spend/)
  // 反向断言：SELECT 不应出现任何 schema 不存在的列
  expect(call[0]).not.toMatch(/redeem_code/)
  expect(call[0]).not.toMatch(/max_claims/)
  expect(call[0]).not.toMatch(/claimed_count/)
})
```

**为什么必须加**：06-1 ticket 已经发现一次"mock 塞 `max_discount` 掩盖 SELECT 漏字段"，本次又发现第二次（塞 `max_claims`/`claimed_count`/`template_expire_at`）。不加抗体第三次还会出现。这一条是本 ticket 与报告 §4.4 的主要增量。

### 4.4 前端 UI 下架

**文件 4**：`fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxml`

删除 L8-28 的兑换码区块：

```diff
 <!-- pagesCoupon/my-coupons/my-coupons.wxml -->
 <wxs module="fmt">
 module.exports.join = function(arr, sep) { return arr ? arr.join(sep) : '' }
 module.exports.slice = function(s, start, end) { return s ? s.slice(start, end) : '' }
 </wxs>
 <van-toast id="van-toast" />

-<!-- 兑换码 -->
-<view class="redeem-section">
-  <view class="redeem-row">
-    <input
-      class="redeem-input"
-      placeholder="输入兑换码"
-      value="{{redeemCode}}"
-      bindinput="onRedeemInput"
-      confirm-type="done"
-      bindconfirm="onRedeem"
-    />
-    <van-button
-      type="primary"
-      size="small"
-      custom-class="redeem-btn"
-      loading="{{redeeming}}"
-      disabled="{{!redeemCode || redeeming}}"
-      bindtap="onRedeem"
-    >兑换</van-button>
-  </view>
-</view>
-
 <van-tabs active="{{activeTab}}" bind:change="onTabChange" line-width="60rpx">
```

**文件 5**：`fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.ts`

删除 `redeemCode` / `redeeming` data 字段以及 `onRedeemInput` / `onRedeem` 两个方法（L14-15, L61-84）：

```diff
 Page({
   data: {
     activeTab: 0,
     coupons: [] as any[],
     isLoading: false,
     loadError: false,
-    redeemCode: '',
-    redeeming: false,
   },
   ...
-  onRedeemInput(e: WechatMiniprogram.Input) {
-    this.setData({ redeemCode: e.detail.value.trim() });
-  },
-
-  async onRedeem() {
-    ...
-    try {
-      await callClientApi('coupon.redeem', { code });
-      Toast.success('兑换成功');
-      ...
-    } catch (err: any) {
-      Toast.fail(err.message || '兑换失败');
-    } finally {
-      this.setData({ redeeming: false });
-    }
-  },
 });
```

**文件 6**：`fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxss`

删除 L8-37 的 `.redeem-section` / `.redeem-row` / `.redeem-input` / `.redeem-btn` 四条样式块（这几条只服务于上面删除的 WXML 区块）。

### 4.5 文档同步

**文件 7**：`fengyu-client/CLAUDE.md`

```diff
-| coupon | list, available, redeem |
+| coupon | list, available |
```

**文件 8**：`fengyu-client/cloudfunctions/clientApi/CLAUDE.md`

```diff
-    ├── coupon.js     # list, available, redeem
+    ├── coupon.js     # list, available
```

### 4.6 不改动

- `db/schema/coupon.ts`：不加 `redeem_code`，维持现状
- `fengyu-admin/src/app/(main)/coupons/`：本就没有 redeem 入口，无需改
- `fengyu-staff/.../coupon.js`：员工端本来就没实现 redeem
- `fengyu-client/CLAUDE.md` / 报告 §4.4：报告文档原则是"审计快照"不改，只在末尾附 ✅ 注记指向本 ticket（见 §7 DoD）

---

## 5 部署与善后

### 5.1 部署顺序

1. 先部 **clientApi 云函数**（删 `redeem` 函数 + 路由注册）→ 即刻止损线上 500
   - 走 `cloudbase-deploy` skill；**禁用** `tcb fn deploy --force`（会重置环境变量）
   - 部署后验证 `PG_CONNECTION_STRING` / `TMAP_KEY` / `TMAP_SECRET` 未被动
2. 再发 **小程序前端**（删 UI + 样式 + data/方法）→ 从源头消除可触发路径
   - 小程序审核通常 1-2 天，先上云函数保护顾客，前端审核通过前旧版本顾客点击会收到"兑换失败"Toast 而非成功（云函数已删路由，`index.js` 路由分发抛 `INVALID_ACTION`），比之前 PG 报错更友好
3. 合并后在 `notes/adapt-plans/06-coupon-model.md` §4.4 末尾追加 ✅ 注记

### 5.2 曝光面 > 0 时的主动通知（可选）

若 §2.1 `exposed_users` 非零且业务侧要求"主动通知"：

- 通过 `messages` 表 `INSERT` 一条系统消息：`"兑换码功能已下线，您的优惠券不受影响，如需领券请联系美容顾问"`
- SQL 落档到 `db/scripts/oneoff/notify-coupon-redeem-removal-{YYYYMMDD}.sql`
- 默认不发通知——兑换功能本来就是崩的，没人"以前用过"，不引入认知混乱

### 5.3 小程序审核驳回的 Plan B

如果小程序审核驳回（审核员可能会问"为什么删掉兑换码功能"），准备以下说明：

> "兑换码功能未投入使用，因产品设计调整为按手机号定向发券。此版本下架未使用的入口。"

---

## 6 风险点

| 风险 | 等级 | 缓解 |
|---|---|---|
| 小程序审核延期导致旧版本顾客仍能触发"兑换失败" Toast | 低 | 云函数先行下线 `coupon.redeem` 路由，旧前端拿到的是 `INVALID_ACTION` 友好报错，不是 500 |
| 删除 UI 后老用户投诉"为什么没兑换入口了" | 低 | 本来就用不了；功能上线前即已崩；无既有用户习惯 |
| 防假阳性抗体断言过严导致正常 SELECT 演进被挡 | 低 | 抗体只断言 3 个"schema 明确不存在"的列不出现，和 4 个"schema 确定存在"的列出现；未来 SELECT 扩展新字段不影响 |
| 删除测试文件整个 describe 块导致总用例数下降 | 低 | 先在本 ticket 记录基线（当前 redeem 11 例 + list/available N 例），清理后对齐 |
| redeem 是小程序被动接口，未来会议临时要回来 | 低 | 本 ticket §3.2 已经列好方案 B 恢复路径 |

---

## 7 验收清单（Definition of Done）

- [ ] §2.1 exposed_users 在 prod 执行完毕，结果录入本 ticket（即使是 0 也记录）
- [ ] §4.1 云函数删除：`coupon.js` redeem 函数消失、`index.js` 路由条目消失
- [ ] §4.2 测试删除：`coupon.test.js` 的 `describe('coupon.redeem')` 11 例消失，顶部注释同步更新
- [ ] §4.3 防假阳性抗体：`coupon.list` 和 `coupon.available` 的测试用例中新增 SELECT 字段断言；`npm test -- routes/coupon` 全绿
- [ ] §4.4 前端 UI 下架：WXML/TS/WXSS 三文件中 `redeem` 相关代码全清，`grep -r redeem fengyu-client/miniprogram/pagesCoupon/` 0 命中（points 页面的 `record-icon-redeem` CSS class 同名不同义，忽略）
- [ ] §4.5 两个 CLAUDE.md 接口表已同步
- [ ] `cloudbase-deploy` 部署 clientApi 成功，环境变量未被动
- [ ] 手工回归：开发者工具打开 `fengyu-client/`，进入"我的优惠券"页，兑换区块已不可见；列表页正常显示已有券
- [ ] `notes/adapt-plans/06-coupon-model.md` §4.4 末尾追加一行：`✅ 2026-04-10 已执行方案 A，同时下架前端 UI。详见 notes/tickets/06-2-client-coupon-redeem-schema-mismatch.md`（不修改原分析，仅追加 ✅ 注记）
- [ ] 本 ticket §1.2 指出的"假阳性测试 mock 模式"同步写入项目反馈记忆（或 06 报告末尾 backlog），防止第三次复发

---

## 8 与报告 §4.4 的关键差异（审计用）

| 维度 | 报告 §4.4 结论 | 本 ticket 修正 |
|---|---|---|
| 严重度 | P1 "死代码 + schema 缺列" | **P0 线上崩溃**——前端有 UI 调用，顾客可触发 |
| 依据 | `grep 'coupon.redeem'` 只命中 index.js + test + CLAUDE.md | 补扫 `miniprogram/pagesCoupon/my-coupons/` 三个文件命中 UI + 调用 |
| 改动面 | 4 个文件（routes/coupon.js + index.js + test + CLAUDE.md） | **8 个文件**（追加 my-coupons.wxml/.ts/.wxss + 第二个 CLAUDE.md） |
| 测试处理 | "删除对 redeem 的测试（如有）" | 不只删——同时在保留的 list/available 用例里加**防假阳性抗体**，根治 06-1 已发现过一次、本次又发现一次的 mock 掩盖 SELECT 问题 |
| 崩溃点 | 只指出 SELECT 4 列 | 额外指出 L287 UPDATE 的 `claimed_count` 也会崩，即使只修 SELECT 仍会在事务里 rollback |
| UPDATE 列问题 | 未提 | L287 `SET claimed_count = claimed_count + 1` 是第 5 个崩溃点（同一列第 2 次引用） |

---

## 9 相关链接

- 上游调研报告：`notes/adapt-plans/06-coupon-model.md` §4.4 / §6（Phase 2-6）
- 孪生 ticket（同报告 §4.3 + 假阳性测试修复模式）：`notes/tickets/06-1-client-discount-coupon-fix.md`
- Schema 定义：`db/schema/coupon.ts:11-43`（`coupon_templates` 全部合法列）
- 正确 SELECT 示例（可作模板对照）：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:122-134`（同文件的 `available` 用到的列在 schema 中都存在）
- 云函数部署 skill：`.claude/skills/cloudbase-deploy/SKILL.md`
- 环境变量风险记忆：`project_cloudbase_envvar_risk`（禁用 `tcb fn deploy --force`）
