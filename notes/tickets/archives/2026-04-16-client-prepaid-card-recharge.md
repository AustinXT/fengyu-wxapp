# Ticket: 顾客端首页新增「充值卡」入口 + 充值页面（阶梯折扣）

> 生成日期：2026-04-16
> 严重级别：P1（产品增量 / 首页核心入口）
> 端：fengyu-client（顾客端）
> 影响面：小程序前端（首页宫格 + 新充值页）+ clientApi 云函数（recharge 相关 action）+ DB（可能需要 migration：sale_order_type 扩枚举或充值商品化处理）

---

## 0 一句话背景

顾客端目前只能在「我的 → 充值卡」看**余额与历史消费**，但没有**主动充值**的入口。会员在门店/员工口头引导下预存金额（workfine 线下流水）无法转为小程序侧留存行为。本 ticket 在首页轮播图下方、「我的疗程」右侧新增「充值卡」宫格按钮，点击跳转新建的**充值选择页**——顾客选预设金额档或自行输入，按金额档自动匹配 9.5–9.9 折优惠，发起微信支付完成充值。

---

## 1 问题定位

### 1.1 现状

| 位置 | 现状 | 能力缺口 |
|---|---|---|
| `pages/home/home.wxml:68-84` 宫格 `.section-grid` | `.grid-row-5` 下仅 2 项：`我的券`、`我的疗程` | 无"充值"入口 |
| `pagesProfile/prepaid-cards/` | 展示 `prepaid_cards` 总余额 + 各卡余额 + `card_transactions` 近半年流水 | 纯只读，不能发起充值 |
| `clientApi/routes/card.js` | `list`（充值卡列表）、`history`（交易记录） | 无 `recharge`、无档位配置接口 |
| `sale_order_type` 枚举 | 销售单 / 内部单 / 回款单 / 转换单 / 退款单（5 值，migration 0028–0031 精简后） | 无"充值单"语义 |

### 1.2 已有可复用资产

| 文件 | 复用点 |
|---|---|
| `pages/home/home.wxml:69-83` | 宫格 `.grid-row-5` 容器 + `.grid-item` 样式，直接在「我的疗程」后追加第 3 项 |
| `pages/home/home.ts:272-285` `onGridTap` | switch/case 分发路由，新增 `case 'recharge'` 即可 |
| `pagesProfile/prepaid-cards/` | 充值完成后返回此页刷新余额 |
| `clientApi/routes/order.js` | 订单号生成 + advisory lock + 微信支付参数返回范式 |
| `utils/cloud.ts → callClientApi` | 统一 API 调用模式 |
| `app.wxss` 状态色 / `brand-gradient` | 充值页主 CTA 用 `#C0322A` 品牌红 |

### 1.3 DB schema 依赖

| 表 | 用途 |
|---|---|
| `prepaid_cards(card_id, user_id, balance, store_id, created_at)` | 充值成功后 UPSERT / INSERT（按门店绑定 or 通用卡，见 §2.5） |
| `card_transactions(id, card_id, type, amount, ref_order_id, created_at)` | 充值流水（type='充值'，amount 为正） |
| `sale_orders` / `sale_items` | 充值支付单（若按"充值单"类型落单，见 §2.4 决策） |
| `sale_order_type` 枚举 | 若选方案 B 需 migration 新增 `充值单` 值 |
| `client_wechat_users` | 取 `user_id` / `phone` 校验 |

---

## 2 设计决策

### 2.1 首页宫格改动

- `pages/home/home.wxml` 在「我的疗程」后追加第 3 个 `.grid-item`：
  - `data-type="recharge"`
  - 图标：`van-icon name="gold-coin-o"`（或走 `/images/icons/grid-recharge.png` 与「我的疗程」风格一致，本 ticket 先用 `van-icon`，后续 UI 统一做图标资源时再替换）
  - 标签：`充值卡`
- `pages/home/home.ts` `onGridTap` 新增 case：
  ```ts
  case 'recharge':
    wx.navigateTo({ url: '/pagesProfile/card-recharge/card-recharge' });
    break;
  ```
- 由于宫格容器类名已是 `.grid-row-5`（按 5 个一排设计），3 项布局不会破版；若视觉上间距过宽，在 `home.wxss` 对 3 项布局做 `justify-content: flex-start` + 固定宽度微调。

### 2.2 新页面：充值选择页

- **路径**：`pagesProfile/card-recharge/card-recharge`
- **标题**：充值卡
- **分包归属**：`pagesProfile`（与 prepaid-cards 同组，符合"个人 → 资产"域）
- **页面布局**（自上而下）：
  1. 顶部说明条：`选择充值金额，金额越大优惠越大`（次级文案）
  2. 4 个预设档卡片（2×2 网格）：
     - 档卡片显示「¥500 / 9.9 折 / 实付 ¥495」
     - 选中态品牌红边框 + 浅红底
  3. 自定义金额输入区：
     - `input` 数字键盘，placeholder `输入充值金额`
     - 下方实时显示：`已匹配 X.X 折 / 实付 ¥XXX.XX`
     - 低于 500 显示提示：`最低充值金额 ¥500`
  4. 底部说明：`充值卡无使用期限，可在凤御双连锁门店消费`（文案待产品确认）
  5. Sticky 底部：大 CTA `立即充值 ¥XXX.XX`（品牌红），点击发起微信支付

### 2.3 金额档位与折扣策略（**暂定，待产品确认**）

| 档位 | 充值金额 | 折扣 | 实付金额 | 赠送金额（到账-实付） |
|---|---|---|---|---|
| T1 | ¥500 | 9.9 折 | ¥495 | ¥5 |
| T2 | ¥1000 | 9.8 折 | ¥980 | ¥20 |
| T3 | ¥2000 | 9.7 折 | ¥1940 | ¥60 |
| T4 | ¥5000 | 9.5 折 | ¥4750 | ¥250 |

> 用户口述"三个默认金额"但列出 4 个（500/1000/2000/5000），本 ticket 按 **4 档** 实施。若产品方选 3 档，删除 T3，折扣改为 `9.9 / 9.8 / 9.5`。

**自定义金额档位匹配**（区间左闭右开）：

| 输入金额 | 折扣 |
|---|---|
| `x < 500` | 不允许（前端拦截 + 云函数二次校验） |
| `500 ≤ x < 1000` | 9.9 折 |
| `1000 ≤ x < 2000` | 9.8 折 |
| `2000 ≤ x < 5000` | 9.7 折 |
| `x ≥ 5000` | 9.5 折 |

> **语义约定**（重要，需与产品对齐）：
> - 方案 A（**推荐**）：顾客实付 `充值金额 × 折扣`，充值卡余额到账 **充值金额**（折扣表现为"送钱"；常见餐饮/会员卡做法）
> - 方案 B：顾客实付 `充值金额`，充值卡余额到账 `充值金额 / 折扣`（折扣表现为"加送"，余额非整数）
>
> 本 ticket 按方案 A 实施；若产品方偏好 B，调整 `payAmount` 与 `creditAmount` 计算公式即可，DB 结构不变。

### 2.4 后端落地模型（已定：走订单 + prepaid_cards + card_transactions）

**用户明确确认（2026-04-16）**：
> 充值卡余额存在 `prepaid_cards`，明细存在 `card_transactions`，需要走订单。

因此本期**不新增 `充值单` 枚举**，**不改 schema**，采用"充值作为特殊商品走销售单"模型：

**数据流（充值→支付→入账）**：

```
用户选档/输入金额
  ↓
clientApi.card.recharge
  ├─ 校验 amount ∈ [500, 100000] 且匹配折扣档
  ├─ 事务内：advisory lock → 生成日序号 → INSERT sale_orders + sale_items
  │    · sale_orders.sale_order_type = '销售单'
  │    · sale_orders.pay_amount       = 面值 × 折扣    （实付）
  │    · sale_items.product_id        = "预付充值卡" 虚拟 SPU
  │    · sale_items.unit_real_price   = 面值 × 折扣
  │    · sale_items.session_count     = 1               （无疗程语义）
  │    · sale_items.product_name_snap = "预付充值卡 ¥{面值}"
  │    · 扩展字段（见下）记面值与折扣：
  │       · sale_items.remark / meta  = { faceValue: 面值, discount: 0.XX, rechargeCardId: 目标卡ID }
  └─ 返回微信支付参数
  ↓
用户完成微信支付 → 微信回调 payNotify
  ↓
payNotify（事务内）
  ├─ 识别：sale_items 存在"预付充值卡"虚拟 SPU 的行
  ├─ 幂等检查：card_transactions WHERE ref_order_id = sale_order_id 是否存在
  ├─ UPSERT prepaid_cards
  │    · 若用户已有通用卡（store_id IS NULL）→ balance += 面值
  │    · 否则 INSERT 新卡（card_id 规则见 §5 风险表）
  └─ INSERT card_transactions
       · type   = '充值'
       · amount = +面值                （充值按面值加余额，实付差价体现为"送钱"）
       · ref_order_id = sale_orders.sale_order_id
```

**为什么走销售单而不是新枚举**：
- 零 DB 变更，不影响 admin 订单页 / staff 订单列表的枚举筛选器
- 财务口径自然纳入销售总额（若财务侧希望单独统计充值，通过 `sale_items.product_id = 预付充值卡虚拟SPU` 过滤即可）
- 与 product_kind 枚举现有值 `充值卡` 对齐（已存在，无需 migration）

**一次性数据准备**：
- 在双库（5433 + 5434）seed 一条"预付充值卡"虚拟商品（`products.product_kind='充值卡'`, `is_bundle=false`, `price=0`, `special_price=NULL`）+ 对应 `product_skus` 占位一条
- 记录其 `product_id` 常量到 `clientApi/routes/card.js` 顶部 `RECHARGE_VIRTUAL_PRODUCT_ID`

> 如后续财务方强烈要求独立枚举 `充值单`，再单独开 ticket + 跑 `wx-change-propagation` 全扫描。

### 2.5 通用卡 vs 门店卡

`prepaid_cards.store_id` 当前可空（通用卡）或指向某门店。本 ticket **统一按"通用卡"（store_id=NULL）入账**，理由：
- 顾客从首页进入，未必明确绑定门店消费意图
- 跨店核销更友好
- 门店专属卡留给未来店长主导的"门店特典"场景

若顾客已绑定门店（`app.globalData.boundStoreId`），创建 `sale_orders.store_id` 仍写该门店，便于销售业绩归属。

### 2.6 幂等与防刷

- 支付回调幂等：payNotify 收到通知时检查 `card_transactions.ref_order_id` 是否已存在（存在则跳过）
- 前端连击防护：CTA 点击后立即 disable，拿到支付参数后唤起微信支付
- 金额校验：前端 + 后端双重校验 `amount ∈ [500, 100000]`，小数位 ≤ 2

### 2.7 折扣配置的可维护性

档位配置（`[{ amount: 500, discount: 0.99 }, ...]`）建议先**硬编码**在：
- 云函数：`clientApi/routes/card.js` 顶部常量 `const RECHARGE_TIERS = [...]`
- 前端：`pagesProfile/card-recharge/card-recharge.ts` 通过 `card.rechargeConfig` 接口拉取（**不在前端硬编码**，以便未来调整不发版）

未来演进：独立表 `recharge_tier_config(id, amount, discount, valid_from, valid_to, is_active)`，admin 可配置。本 ticket **不做**，仅在 card.js 顶部留 TODO。

---

## 3 实施计划

### 3.1 前端（fengyu-client/miniprogram）

| # | 文件 | 改动 |
|---|---|---|
| F1 | `pages/home/home.wxml` | `.grid-row-5` 追加第 3 个 `.grid-item`（data-type="recharge"） |
| F2 | `pages/home/home.ts` | `onGridTap` switch 新增 `case 'recharge'` → navigateTo |
| F3 | `pagesProfile/card-recharge/card-recharge.{wxml,wxss,ts,json}` | **新建**页面 4 文件 |
| F4 | `app.json` | 在 `pagesProfile` 分包的 pages 数组新增 `pagesProfile/card-recharge/card-recharge` |
| F5 | `pagesProfile/card-recharge/card-recharge.test.ts` | **新建**单测：档位匹配、金额校验、实付计算（vitest） |

### 3.2 云函数（fengyu-client/cloudfunctions/clientApi）

| # | 文件 | 改动 |
|---|---|---|
| B1 | `routes/card.js` | 新增 `rechargeConfig(ctx)`：返回 4 档配置 `{ tiers: [...], minAmount: 500, maxAmount: 100000 }` |
| B2 | `routes/card.js` | 新增 `recharge(ctx)`：校验金额 → 匹配档位 → 事务内 advisory lock 生成序号 → INSERT sale_orders + sale_items（虚拟 SPU，`unit_real_price = 面值 × 折扣`，meta 记录 faceValue/discount）→ 返回微信支付参数 |
| B3 | `index.js` | 路由映射补：`card.rechargeConfig`、`card.recharge` |
| B4 | `cloudfunctions/payNotify/index.js` | 支付成功回调分支：识别 sale_items 虚拟 SPU = 预付充值卡 → 幂等检查 `card_transactions.ref_order_id` → UPSERT prepaid_cards（通用卡累加 / 否则新建）+ INSERT card_transactions(type='充值', amount=+面值, ref_order_id=sale_order_id) |
| B5 | `routes/card.test.js`（若项目已有 jest/vitest 配置）或手动验证脚本 | 档位匹配 + 实付计算 + 幂等单测 |

### 3.3 DB 与 seed

| # | 操作 |
|---|---|
| D1 | 在 products 插入一条"预付充值卡"虚拟商品（`is_bundle=false`, `product_kind='充值卡'`, `price=0`），外加一条 product_skus 占位行；**双库 seed（5433 + 5434）**；记录返回的 `product_id` 常量 |
| D2 | **无 migration**（沿用 `prepaid_cards` / `card_transactions` / `sale_orders` / `sale_items` 现有 schema，不扩枚举） |

### 3.4 admin 端（可延后，不阻塞本 ticket）

- 订单列表页筛选器：通过「商品类型 = 充值卡」即可过滤充值单（现有 `product_kind` 筛选即覆盖）
- 数据看板：充值流水是否计入 GMV？需与产品/财务确认（本 ticket 标注待确认，**不改 dashboard**）

### 3.5 文档

- `.42cog/pm/client.pr.spec.md` 在 PR 合并后补条目（新增「充值卡购买」业务域）
- 本 ticket 与 `project_workfine_maintenance.md` 中的"业务填报"任务解耦（线下老充值卡仍由 workfine 同步）

---

## 4 验收标准

1. **首页入口**：打开小程序首页，轮播图下方宫格显示 3 项（我的券 / 我的疗程 / 充值卡），点击「充值卡」进入充值选择页
2. **档位展示**：充值页渲染 4 个预设档，每档显示金额 / 折扣 / 实付，默认无选中
3. **档位选中**：点击任一档 → 选中态（品牌红边框 + 浅红底），其他档还原，CTA 更新为「立即充值 ¥X.XX」
4. **自定义金额匹配**：
   - 输入 `499` → 提示「最低充值金额 ¥500」，CTA 禁用
   - 输入 `500` → 显示「9.9 折 / 实付 ¥495」，CTA 启用
   - 输入 `999` → `9.9 折 / 实付 ¥989.01`
   - 输入 `1000` → `9.8 折 / 实付 ¥980`
   - 输入 `2000` → `9.7 折 / 实付 ¥1940`
   - 输入 `5000` → `9.5 折 / 实付 ¥4750`
   - 输入 `10000` → `9.5 折 / 实付 ¥9500`
5. **支付闭环**：
   - 点击 CTA → `card.recharge` INSERT sale_orders + sale_items（虚拟 SPU）→ 返回微信支付参数 → `wx.requestPayment` 唤起微信支付
   - 模拟支付成功 → payNotify：UPSERT prepaid_cards（balance += **面值**，非实付）+ INSERT card_transactions(type='充值', amount=+面值, ref_order_id=sale_order_id)
   - 返回上级页面时，充值卡余额页可见新余额
   - admin 订单列表查询能看到这张 sale_orders（商品名="预付充值卡 ¥{面值}"）
6. **幂等**：payNotify 重复回调不产生重复流水 / 重复余额（`ref_order_id` 去重）
7. **鉴权**：未绑定手机号的用户点击 CTA → 引导绑定手机号弹窗
8. **无登录态**：未登录用户点击首页「充值卡」→ 引导登录（现有 `requireLogin` 模式）
9. **金额校验**：云函数侧 `amount < 500 || amount > 100000 || 小数位 > 2` 返回 `INVALID_PARAMS`
10. **单测**：档位匹配函数 `matchTier(amount)` 覆盖边界（499 / 500 / 999 / 1000 / 1999 / 2000 / 4999 / 5000 / 10000）全绿
11. **视觉**：充值页 CTA 使用 `#C0322A`，选中态底色 `#FFF0EE`；宫格图标与现有 2 项视觉一致
12. **回归**：首页轮播 / 搜索 / 商品目录滚动切换 / 购物车 FAB 行为不变

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 产品未确认折扣档次 / 实付语义 | 本 ticket §2.3 明确"暂定"方案（9.9 / 9.8 / 9.7 / 9.5 + 到账面值），PR 前请产品方勾选 |
| 支付回调丢失 / 顺序错乱 | payNotify 按 `ref_order_id` 做幂等；prepaid_cards UPSERT 用 `ON CONFLICT (user_id, store_id) DO UPDATE SET balance = prepaid_cards.balance + EXCLUDED.balance`（通用卡的 store_id=NULL 需确认 UNIQUE 约束是否支持，否则改走先查后写 + SELECT FOR UPDATE） |
| `prepaid_cards` 是"每卡一行"（`routes/card.js:13-19` 可见一个用户可多张卡） | 本 ticket 新充值逻辑：若用户已有"通用卡"（store_id IS NULL）→ 累加余额；否则新建一张通用卡。card_id 规则建议 `FY-CARD-WX-{userId前8位}-{YYMMDDHHMMSS}`；具体规则 PR 前与后端协商敲定 |
| 虚拟 SPU "预付充值卡" 可能误出现在商品浏览 / 搜索结果中 | seed 的虚拟商品需标注 `is_hidden=true` 或不挂任何 `category_id`；并在 `product.shopInit` / `product.spuList` / `searchProducts` 过滤；需确认 `products` 表是否有 is_hidden 字段，无则 ad-hoc 用特定 product_id 硬过滤 |
| 折扣配置硬编码导致运营改价需发版 | TODO 注释标注"后续独立表化（recharge_tier_config）"；本期验收不阻塞 |
| 自定义金额浮点精度 | 前端 input type=digit，后端 `Math.round(amount * 100) / 100`；实付 `Math.round(amount * discount * 100) / 100`；sale_orders / card_transactions 金额列统一 numeric(12,2) |
| 首页宫格是 `grid-row-5`（按 5 项设计），3 项排布可能视觉松散 | 若设计方反馈，在 `home.wxss` 加 `justify-content: flex-start` 或改类名 `grid-row-3` 调整；默认保留 row-5 |

---

## 6 待产品 / 运营确认（PR 前必须答复）

**已由用户确认（2026-04-16）**：
- ✅ 余额存 `prepaid_cards`，明细存 `card_transactions`
- ✅ 充值**走订单**（sale_orders + sale_items，虚拟 SPU "预付充值卡"，不新增枚举）

**仍待确认**：

1. 预设金额档是 **3 档** 还是 **4 档**？（用户描述"三个"，但列出 500/1000/2000/5000 共 4 个）
2. 折扣具体数值（暂定 9.9 / 9.8 / 9.7 / 9.5）是否需微调？是否启用 9.6？
3. 实付语义：**到账=面值 / 实付=面值×折扣**（暂定，"送钱"模式）✓？还是改为 **到账=面值/折扣 / 实付=面值**（"加送"模式）？
4. 最低充值金额 **¥500** ✓？最大充值金额上限（本 ticket 暂定 ¥100000）
5. 充值卡绑定策略：**通用卡（跨店可用，暂定）** ✓？还是绑定到当前已绑定门店？
6. 充值流水在财务报表里是否计入 GMV？dashboard 是否需专门拆一列"充值收入"？
7. 充值卡是否有**使用期限**（过期作废 / 永久有效）？
8. 售后策略：支持退款吗？已消费部分如何处理？（若暂不支持，UI 需明确说明）
9. 虚拟 SPU "预付充值卡" 是否会被列进 admin 的商品管理列表？（建议过滤，不暴露给运营编辑）

---

## 7 前置依赖

- 微信支付商户号已对接（现有 `order.pay` 已验证）
- `prepaid_cards` / `card_transactions` 表已存在（见 routes/card.js）
- `client_wechat_users.phone` 非空（rechargeAction 前置 `requirePhone` 中间件）

---

## 8 相关文件

- `fengyu-client/miniprogram/pages/home/home.wxml:68-84` — 宫格容器
- `fengyu-client/miniprogram/pages/home/home.ts:272-285` — onGridTap
- `fengyu-client/miniprogram/pagesProfile/prepaid-cards/prepaid-cards.{ts,wxml}` — 余额页（充值成功后返回此页可见更新）
- `fengyu-client/cloudfunctions/clientApi/routes/card.js` — 待扩展 `rechargeConfig` / `recharge`
- `fengyu-client/cloudfunctions/clientApi/routes/order.js` — 订单创建 / 支付参数 / advisory lock 模板
- `fengyu-client/cloudfunctions/payNotify/` — 支付回调（新增虚拟 SPU 识别分支）
- `db/schema/enums.ts` — `product_kind` 现有值 `充值卡` 直接用（无 migration）
- `db/schema/order.ts` — `sale_orders` / `sale_items` 结构（meta 或 remark 字段承载 faceValue/discount 需确认存在）
- `.42cog/pm/client.pr.spec.md` — 待该 PR 合并后补 AC
