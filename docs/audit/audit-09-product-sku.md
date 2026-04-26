# 审计报告：商品 + SKU + 价格 + 有效期 (09)

**审计时间**：2026-04-25 HH:MM
**域 ID**：09
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—
**Slug**：product-sku

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/product.ts:18-170`（`productCategories` / `products` / `productSkus` / `mallCategories` / `mallBundleGroups` / `mallProductSkus`） | ↑ | ↑ |
| Enum | `db/schema/enums.ts:3 productTypeEnum`（疗程卡/单品/家居产品）；`product_kind` 完全 DB 驱动（`productCategories.productKind` 自由文本） | ↑ | ↑ |
| Action / Route | `fengyu-admin/src/actions/products.ts:1-1647`（27 个 server actions） | `staffApi/routes/product.js:1-493`（shopInit/categories/skuList/skuDetail/spuDetail/cardKinds/promotionList/promotionPlans）；`staffApi/routes/mgmt-product.js:1-397`（cardHolders/cycleStats，看板 only） | `clientApi/routes/product.js:1-419`（categories/spuList/skuDetail/spuDetail/hotList/shopInit） |
| 前端 | `fengyu-admin/src/app/(main)/products/{page.tsx,[id]/page.tsx,create/page.tsx,categories/page.tsx,_components/products-page.tsx}` + `(main)/mall/{page.tsx,[id]/page.tsx,create/page.tsx,categories/page.tsx,_components/mall-page.tsx}` | `fengyu-staff/miniprogram/pages/order-create/order-create.ts`（取 shopInit） | `fengyu-client/miniprogram/pages/shop/*` + `pages/product-detail/*` |
| 测试 | `fengyu-admin/src/actions/products.test.ts`（843 行） | `staffApi/__tests__/routes/product.test.js`（613 行） | `clientApi/__tests__/routes/product.test.js`（198 行） |

---

## 2. 数据流图

```
admin.createSku ─┬─> product_skus（price, special_price, session_count, service_fee, is_shengmei, is_enabled）
                 └─> mallProductSkus（关联到商城商品 SPU；可选 bundlePrice / bundleGroupId）

staff.shopInit / client.shopInit
   └─> product_categories WHERE is_valid=true
       └─> product_skus WHERE is_enabled=true（仅列表过滤；无有效期过滤——schema 无 valid_*）
       └─> products WHERE is_enabled=true AND is_visible=true（套餐 SPU）

staff.order.create / client.order.create
   └─> SELECT product_skus WHERE sku_id = $1
       └─> 价格快照 → sale_items.unit_price / unit_real_price / service_fee / is_shengmei / sales_category
       └─> 不校验 sk.is_enabled（绕过下架）；不校验 market_scope；不校验有效期（无字段）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-09-01] order.create（staff + client）查询 SKU **不带 `is_enabled` 过滤**，已下架 SKU 仍可下单
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:257-265`（`SELECT ... FROM product_skus WHERE sku_id = $1` 未带 `AND is_enabled = true`）
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js:196-204`（`SELECT ... FROM product_skus WHERE sku_id = ANY($1)` 未带 `AND sk.is_enabled = true`）
  - `fengyu-admin/src/actions/orders.ts`（admin createOrder 同样仅 `inArray(productSkus.skuId, skuIdList)`，无 `eq(productSkus.isEnabled, true)`）
- **现象**：三端 product 列表/shopInit/spuDetail 都用 `sk.is_enabled = true` 过滤；但 `order.create` 直接按 skuId 查全部（含已停用）。
- **风险**：
  1. 管理端"下架"操作语义失效——任何缓存了 skuId 的客户端、分享链接、扫码二维码、伪造 payload 都能以下架 SKU 价格下单。
  2. 价格调整后"先涨价、再下架"的运营动作会被绕过：调价瞬间生效但下架同时段订单仍按旧价快照（real.md #2 "价格快照不可变" 失效边界）。
- **复现**：
  1. admin 把 sku=`SKU-X` 改 `isEnabled=false`
  2. 顾客 / 店长 在前端缓存的旧购物车里点"提交"，直接传 skuId=SKU-X 给 order.create
  3. 订单成功创建，sale_items.unit_price = SKU-X 旧价格
- **修复**：(L3) 三端 order.create 的 SKU 查询统一加 `AND sk.is_enabled = true`，同时 admin createOrder 加 `eq(productSkus.isEnabled, true)`；命中数 < skuIdList.length 即抛 `INVALID_PARAMS: SKU ${id} 已下架`。

#### [P0-09-02] order.create 不校验 SKU 的 `market_scope`，跨市场可下单
- **文件**：
  - `db/schema/product.ts:60`（productSkus.marketScope）/ `:111`（products.marketScope）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:257-265` / `fengyu-client/cloudfunctions/clientApi/routes/order.js:196-204` / `fengyu-admin/src/actions/orders.ts`
- **现象**：
  - product 列表查询都按 `market_scope IS NULL OR market_scope = $boundMarketName` 过滤（client product.js:24-27, 60-64, 109-113, 264-268）
  - **order.create 阶段完全不复核 market_scope**——攻击者直接传跨市场 skuId 即落单
- **风险**：market_scope 是"商品仅对某市场可见/可售"的隔离手段（real.md #6 组织域数据隔离的商品维度）。下单不复核即可让商品被任何市场顾客购买，破坏市场专享 SKU/特价的商业边界。
- **复现**：A 市场专享特价卡 sku=`MSCD-A`，B 市场顾客直接调 client.order.create({ skuId: 'MSCD-A' }) → 成功
- **修复**：(L3) order.create SKU 查询追加 `AND (sk.market_scope IS NULL OR sk.market_scope = $boundMarketName)`；同时校验 product.market_scope（套餐场景）

#### [P0-09-03] admin `deleteSku` 两步硬删除**不在事务内**，故障可留孤儿态
- **文件**：`fengyu-admin/src/actions/products.ts:633-654`
- **现象**：
  ```ts
  // 先删关联
  await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))
  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))
  ```
  两个 `db.delete` 不在 `db.transaction` 内。第一步已成功后第二步若失败（连接断、唯一约束、权限等），mall_product_skus 关联清空、productSkus 仍存在 → 商城页 SPU 没有 SKU 选项；或者反之。
- **风险**：
  1. 数据完整性破坏，不可逆（已关联 mallProductSkus 数据无审计、无法回滚到删除前关联）
  2. saleItems 的 FK 约束保护无效，因为 saleItems 的 skuId 列允许 NULL（`db/schema/order.ts:145`）—— ON DELETE 走 NO ACTION 但同 SKU 已无销售记录的"未引用 SKU"会直接 hard-delete，下游 service_orders / sale_allocations / commission_rate_matrix 历史报表中存在的 skuId 字符串失去关联。
- **修复**：(L7) 用 `db.transaction(async (tx) => { ... })` 包裹两步；同时拦截额外引用源（services 表 `service_items.sale_item_id` → sale_items.skuId 间接引用，建议同事务内额外查 `service_items WHERE sale_item_id IN ...` 是否存在）。

### 3.2 P1（一致性 / 状态错乱）

#### [P1-09-04] 三端 sale_items.unit_price 写入语义分裂（特价 vs 原价）
- **文件**：
  - staff `staffApi/routes/order.js:271-291`：`basePrice = special_price || price`；`unitPrice = basePrice`（除了内部单 ×0.5 / customPrice 分支）；`saleAmount = unitPrice × quantity`
  - client `clientApi/routes/order.js:222-227`：`unitPrice = Number(sku.price)`（**原价**）；`unitRealPrice = Number(sku.special_price || sku.price)`（特价）；`saleAmount = unitRealPrice × quantity`
  - admin `fengyu-admin/src/actions/orders.ts:613-740`：信任前端传入 `unitPrice` / `unitRealPrice`，无服务端重算
- **现象**：同一 SKU（标价 1000，特价 800）三端 INSERT sale_items 后：
  - staff: unit_price=800, unit_real_price=800, sale_amount=800
  - client: unit_price=1000, unit_real_price=800, sale_amount=800（其中 sale_amount=unit_real_price×qty，与 schema 注释 `unit_price * quantity` 不符）
  - admin: 取决于前端传值（无校验）
- **风险**：
  1. **数据语义不可对账**：BI 报表 SUM(sale_amount) / SUM(unit_price * quantity - sale_amount) 在 staff/client/admin 数据混杂时口径漂移。
  2. **退款比例计算飘移**：staff `approveRefund` / admin `recordPayment` 按 sale_items.unit_price / received 比例分摊储值卡 / 提成回滚，三端写入同一 SKU 不同 unit_price，结算金额不同。
  3. 命中 real.md #2 "价格快照不可变" 的次生影响：快照本身是不可变的，但**写入瞬间值就已经分裂**，导致"快照"在不同端不等价。
- **修复建议**：(L0) 统一 schema 注释 + 抽 `db/helpers/price-snapshot.ts`：`snapshotItemPrice(sku, customPrice?, isInternal?) → { unitPrice, unitRealPrice, saleAmount, received, serviceFee, isShengmei }`，三端共用；明确 `unitPrice = sku.price`（原价快照）、`unitRealPrice = special_price || customPrice || price`（实际单价）、`saleAmount = unitPrice × quantity`（原价 × 数量，不含优惠券分摊）、`received = saleAmount - discount`。

#### [P1-09-05] productType 与 product_kind 两套并存语义模糊
- **文件**：
  - `db/schema/enums.ts:3` `productTypeEnum`（PG 枚举：疗程卡/单品/家居产品，3 值，`product_skus.product_type` 必填）
  - `db/schema/product.ts:21` `productCategories.productKind`（自由 text，DB 驱动；权威值由 PLAN 列出 4 值：护理项目/家居产品/充值卡/体验卡）
  - 三端 SELECT 经常 JOIN 出 productType + productKind 同时返回（`staffApi/routes/product.js:142-145, 387-394`、`clientApi/routes/product.js:148-167`）
- **现象**：
  - productType（疗程卡/单品/家居产品）描述"扣次/提货机制"
  - productKind（护理项目/家居产品/充值卡/体验卡）描述"业务大类"
  - 但二者**值域有重叠**："家居产品" 同时在 productType 和 productKind 中存在，数据 JOIN 后前端两个字段可能不等（productType=家居产品 + productKind=护理项目）—— schema 层未约束一致性。
  - 商品上架/下架完全靠 `is_enabled`（productType 无生命周期意义）
- **风险**：mgmt-dashboard 报表 `cardHolders` 统计"持卡人数"用 `product_type IN ('疗程卡','单品')`（`mgmt-product.js:174`），把"单品"也算成"持卡"——若运维新建 `product_kind=家居产品` 但 SKU 误填 `product_type=单品`，会被误统计为持卡。
- **修复建议**：(L0/spec) 在 `db/schema/product.ts:47` productSkus.productType 注释和 `.42cog/cog.md` 明确两者关系；考虑新增 CHECK 约束保证组合合法（如：`productKind=充值卡 ⇒ productType IN ('单品')`）。

#### [P1-09-06] PLAN 检查点 valid_start / valid_end **schema 不存在**（spec 与现实脱节）
- **文件**：
  - 当前 `db/schema/product.ts:18-72`（productCategories / productSkus）**完全无 valid_start / valid_end 字段**
  - `db/migrations/_archive_pre_baseline_2026_04/snapshots/0010_snapshot.json:423-435` 显示 baseline reset 之前 product_spu / catalog_items 曾有该字段
  - PLAN §2 行 71 "关键检查点" 列出 `price/special_price/valid_start/valid_end` 作为本域必查
- **现象**：审计任务要求验证"当前时间在有效期内才可下单"，但 schema 已无此字段；下架仅靠 `is_enabled` 布尔，无定时下架/定时上架。
- **风险**：
  1. 限时活动 SKU（如 6 月 1 日上线、6 月 30 日下线）需运营人工切 isEnabled，错过时间窗的订单按错价格下单。
  2. 退款窗口无 schema 兜底（任何已下单 SKU 永久可退，无"超有效期不退"语义）。
- **修复建议**：(L0) 评估是否补 valid_start / valid_end 列 + CHECK 约束；或在 `system_configs` 用 cron 定时任务批量更新 isEnabled（参考 STEP 6 关闭超期预约模式）。

#### [P1-09-07] admin 信任前端传入 `unitPrice` / `unitRealPrice` 而不重算
- **文件**：`fengyu-admin/src/actions/orders.ts:613-740`
- **现象**：admin createOrder 入参 items 含 `unitPrice` / `unitRealPrice` 字符串，整段逻辑没有 `db.select(productSkus.price)` 二次校验。注释 `:638` 提到"faceValue 经 matchTier 反推 payAmount"仅在充值卡 tier 单适用，普通单仍信任前端。
- **风险**：admin 用户（含 product 角色）可在抓包/控制台改 `unitPrice` 字段，绕过商品维护页面的"调价"权限审计；与 audit-08 P1-08-14（admin 后端不重算 commission rate）同模式问题。
- **修复**：(L7) admin createOrder 在事务内 `SELECT productSkus.price, special_price WHERE sku_id IN ($skus)` 重算 `unitPrice`，与前端传值不等且 deltaRatio > 容忍阈值（如 5%）则要求二次确认或日志告警。
- **横切归并**：CC1 "后端不重算前端传入金额"（08 域首次发现，本域首次后续命中）

#### [P1-09-08] mall_product_skus.bundle_price 越界不校验（可填 > sku.price 的"加价套餐"）
- **文件**：`fengyu-admin/src/actions/products.ts:706-729 updateSkuBundlePrice` / `:843-865 updateSkuBundleGroup`
- **现象**：`bundle_price` 是套餐内优惠价（schema 注释 `db/schema/product.ts:162`），但 `updateSkuBundlePrice` 仅做格式校验，不强制 `bundlePrice <= productSkus.price`。
- **风险**：套餐特价 > 单卖价时，前端仍按 `bundle_price` 显示套餐价，顾客实付价高于单买更便宜，UX/合规风险；且 client `priceFrom = Math.min(bundle_price || special || price)` 取 min，但套餐选购时 admin 写出大于 special_price 的 bundle_price 后端不报错。
- **修复**：(L7) bundle_price 写入时校验 `<= productSkus.price`；schema 加 CHECK `bundle_price IS NULL OR bundle_price >= 0`（实际尚无 CHECK，建议补 + 上界）。

#### [P1-09-09] 三端 SKU 列表 + 详情字段集合不一致
- **现象**：
  - staff `product.skuList` / `skuDetail` 输出：skuId / specName / price / specialPrice / sessionCount / productType / serviceFee / isShengmei / categoryName / productKind / salesCategory / **isBundle**
  - client `product.skuDetail` 输出：sk.* 列直接（无格式化），无 isBundle，含 service_fee 但驼峰/下划线混杂
  - admin `getSkuById` / `getAllSkus` 输出：所有 schema 字段 + categoryName / productKind / salesCategory
- **风险**：前端类型定义跨端复用易踩坑（staff 用 isBundle 字段触发 BundlePicker、client 不返该字段则 BundlePicker 永远不触发）；本质是**数据合约缺乏单一权威 type 定义**。
- **修复**：(L0/L9) 抽 `db/types/product-sku.dto.ts`，三端 server 端按统一 DTO 输出。

#### [P1-09-10] productKind 在三端被当作"枚举"消费但实际是 free text
- **现象**：
  - DB 驱动设计原意：运营自由新建 kind（PLAN "动态字段 migration 0014"）
  - 但 staff `CARD_PRODUCT_KINDS = ['充值卡', '体验卡']` 硬编码兜底 (`product.js:29`)
  - admin `getProductsByKind('__bundle__' | '__normal__' | string)` 用 string 类型但 spec 4 值（护理项目/家居产品/充值卡/体验卡）
  - 部分前端（小程序 order-create 页面）按字面量判断"卡类 vs 普通"
- **风险**：运营在 admin 新建 kind=`微整美容` 后，shopInit 不会把它分组，cardKinds DB 驱动 ✓ 但三端硬编码兜底掩盖了配置错误。
- **修复**：(L3) staff 把 CARD_PRODUCT_KINDS 兜底标记为"仅当 cardKinds() DB 查询失败"才使用；前端去掉所有字面量分支，统一通过 `product.cardKinds` action 拿 names。

#### [P1-09-11] sale_amount 列与 unit_price × quantity 不变量缺 CHECK
- **文件**：`db/schema/order.ts:159 saleAmount`
- **现象**：
  - schema 注释（订单 spec）暗含 `sale_amount = unit_price * quantity`
  - client 写入 `saleAmount = unitRealPrice * quantity`（原价 ≠ unit_price 时不等）
  - 无 schema CHECK 约束
- **风险**：审计 SUM(sale_amount) - SUM(unit_price * quantity) 不为 0 时无法快速定位是哪端写脏数据。
- **修复**：(L0) 评估加 `CHECK (sale_amount = unit_price * quantity)`，但需先做数据回填（运行时已有不一致行）。

### 3.3 P2（代码质量 / 可维护）

#### [P2-09-12] staff `promotionList` / `promotionPlans` 死路由（永远返回空）
- **文件**：`staffApi/routes/product.js:476-484`、`staffApi/index.js:54-55`
- **现象**：注释明确"已迁移至 PG 商品体系，原 WorkFine 促销查询已废弃"；返回 `{ schemes: [] }` / `[]`。但路由仍注册，前端 `miniprogram/mock/product.ts:222` 还有 mock。
- **修复**：(L3) 从 index.js 删除路由 + 函数定义 + mock；保留前端调用点的兼容降级即可。

#### [P2-09-13] productType 校验白名单字符串硬编码
- **文件**：`fengyu-admin/src/actions/products.ts:530`
  ```ts
  const VALID_PRODUCT_TYPES = ['疗程卡', '单品', '家居产品'] as const
  ```
- **现象**：与 `productTypeEnum` 重复定义；如果 enum 改值集合（已是 PG 枚举，需 ALTER TYPE），应用层不会同步。
- **修复**：(L7) 直接从 schema 导入 enum 值列表，避免重复硬编码。

#### [P2-09-14] product 路由错误前缀使用 `INVALID_PARAMS:` OK，但 SKU 不存在场景文案漂移
- **文件**：staff/client `product.js` 多处 `throw new Error('INVALID_PARAMS: SKU 不存在')`
- **现象**：符合 4 种约定前缀，但 admin actions 返回 `{ success: false, message: 'SKU 不存在' }`（无前缀）—— 跨端文案映射难统一
- **关联**：CC5 已多轮命中

#### [P2-09-15] mall_product_skus.bundle_price 字段语义双重消费
- **文件**：客户端 `clientApi/routes/product.js:178, 311, 382` 都用 `bundle_price || special_price || price` 取 priceFrom
- **现象**：bundle_price 优先级最高 — 但当一个 SKU 同时关联到普通商品和套餐商品时，"非套餐场景显示价"会被套餐价覆盖。
- **修复**：(L3) 取 priceFrom 时按 `is_bundle` 判断分支：套餐取 bundle_price，普通取 special || price。

#### [P2-09-16] mallBundleGroups schema 缺 sortOrder UNIQUE per product
- **文件**：`db/schema/product.ts:138-141`
- **现象**：仅 `uniqueIndex('uq_bundle_group')` on (productId, groupName)；同 productId 下 sortOrder 可重复 → 前端展示顺序非确定（按 (sort_order, id) 才稳定）。
- **修复**：(L0/optional) ORDER BY 加 secondary key `id`。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| order.create 校验 is_enabled | ✗ | ✗ | ✗ | 已下架 SKU 三端皆可下单 | **P0** |
| order.create 校验 market_scope | ✗ | ✗ | ✗ | 跨市场购买 | **P0** |
| sale_items.unit_price 写入语义 | 信任前端 | special_price 优先 | price（原价） | 三端同 SKU 写不同值 | P1 |
| sale_amount 计算口径 | 取前端 saleAmount 或 unitRealPrice×qty | unitPrice × qty | unitRealPrice × qty | 报表口径漂移 | P1 |
| SKU 价格读取来源 | productSkus.price + specialPrice | 同 | 同 | OK | — |
| 价格快照写入 unit_real_price | sale_items.unit_real_price | 同 | 同 | 快照机制存在 | OK |
| productKind 处理 | 4 值 + DB 自由扩展 | DB + CARD_PRODUCT_KINDS 兜底 | DB only | staff 硬编码字面量 | P1 |
| isBundle 字段 | products.isBundle 列存 | shopInit 反查 mall_product_skus 标 isBundle=true | 不返该字段 | 前端 BundlePicker 触发不一致 | P1 |
| 卡类一级 names 来源 | getCardKindNamesFromDb（DB 驱动） | cardKinds() action（DB + 兜底） | 不感知（无对应 action） | 客户端商城 tag 颜色 OK（用 display_color JOIN） | P2 |
| product 列表 is_enabled / is_visible 过滤 | ✓（getProducts list） | ✓（PRODUCT_VALID_FILTER） | ✓（PRODUCT_VALID_FILTER） | OK | — |
| 价格 service_fee 快照 | createSku 校验 ≥ 0 | sale_items.service_fee = sk.service_fee × qty | 不快照（client 不写 service_fee） | client 端订单服务提成基线缺失 | P1 |
| productType 4/5 值 | 3 值校验白名单 | 跟随 PG enum | 跟随 PG enum | admin 与 PG enum 重复硬编码 | P2 |
| `bundle_price` 设置上限 | ✗ | — | — | 套餐反向加价无拦截 | P1 |
| order.create SKU 鉴权 | requirePermission | requireStaffBound + requireManager | requirePhone + 顾客身份 | OK | — |
| product 浏览鉴权 | requirePermission('product:list') | requireStaffBound | **无任何鉴权（匿名 OPENID 可读）** | 商城公开访问产品需求允许 | P2（合规说明） |

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：金额字段 NUMERIC(10,2) ✓；JS 端用 Number 直加 + Math.round(*100)/100 模式（`order.js` 多处）；CHECK `chk_sku_price`/`chk_sku_service_fee` 已加；admin 信任前端 unitPrice → 命中 P1-09-07（CC1 后续命中：08 域 P1-08-14）
- [ ] **CC2 并发幂等**：admin.deleteSku 两步硬删除非事务（P0-09-03，新增）；mall_product_skus 关联与 productSkus 主体的 ACID 缺失
- [ ] **CC3 组织域隔离**：order.create 不复核 market_scope（P0-09-02 新增 — CC3 后续命中）；product 列表层用 marketName 过滤 ✓
- [x] **CC4 后端鉴权**：admin actions 全部 requirePermission ✓；staff 全部 requireStaffBound ✓；client product 路由无 requirePhone 但产品需求允许匿名浏览 → P2 仅备案
- [ ] **CC5 错误码**：staff/client 用 `INVALID_PARAMS:` ✓；admin 用 `{ success: false, message: '...' }`（无前缀）→ 已多轮命中（CC5）
- [x] **CC6 PII**：本域不涉及
- [x] **CC7 时间字段**：created_at / updated_at 由 Drizzle `defaultNow()` + `$onUpdate(() => new Date())` 统一管理 ✓（`db/schema/product.ts:29-30, 62-63, 116-117`）
- [x] **CC8 WXML/Vant**：本域不涉及
- [ ] **CC9 测试与残留**：
  - staff promotionList / promotionPlans 死路由 + mock 残留（P2-09-12）
  - PLAN 检查点 valid_start / valid_end 字段已删除但任务清单未更新（P1-09-06，spec 与现实脱节）
  - admin VALID_PRODUCT_TYPES 硬编码与 PG enum 重复（P2-09-13）
  - 已废弃枚举 big_category / workfine_source / 组合套餐（kind） 全仓 grep 0 命中 ✓
  - 已废弃表 product_spu / product_spu_sku_map / catalog_items / material_products / promotion_schemes 全仓 grep 仅 archive snapshot 命中 ✓

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/product.ts:60` | productSkus.marketScope CHECK；评估补 valid_start/valid_end | P0-09-02, P1-09-06 |
| L0 schema | `db/schema/order.ts:159` | sale_items 加 CHECK (sale_amount = unit_price × quantity) — 但需先回填 | P1-09-11 |
| L0 schema | `db/schema/product.ts:162` | mall_product_skus.bundle_price CHECK <= productSkus.price（trigger） | P1-09-08 |
| L0 helper | `db/helpers/price-snapshot.ts` (new) | 抽统一 `snapshotItemPrice(sku, customPrice?, isInternal?)` | P1-09-04 |
| L0 helper | `db/types/product-sku.dto.ts` (new) | 三端共用 SKU DTO | P1-09-09 |
| L3 staff | `staffApi/routes/order.js:257-265` | SQL 加 `AND sk.is_enabled = true AND (sk.market_scope IS NULL OR sk.market_scope = $boundMarketName)` | P0-09-01, P0-09-02 |
| L3 client | `clientApi/routes/order.js:196-204` | 同上 | P0-09-01, P0-09-02 |
| L3 staff | `staffApi/routes/product.js:476-486` + `index.js:54-55` | 删除 promotionList / promotionPlans 死路由 | P2-09-12 |
| L3 staff | `staffApi/routes/product.js:29` | CARD_PRODUCT_KINDS 兜底标注"仅当 DB 查询失败"使用 | P1-09-10 |
| L7 admin | `fengyu-admin/src/actions/orders.ts:613-740` | createOrder 服务端重算 unitPrice，与前端值差异告警 | P1-09-07 |
| L7 admin | `fengyu-admin/src/actions/products.ts:633-654` | deleteSku 用 `db.transaction` 包两步删除 | P0-09-03 |
| L7 admin | `fengyu-admin/src/actions/products.ts:530` | VALID_PRODUCT_TYPES 改从 productTypeEnum 导入 | P2-09-13 |
| L7 admin | `fengyu-admin/src/actions/products.ts:706-729` | updateSkuBundlePrice 校验上限 | P1-09-08 |

---

## 7. 验证 SQL（5434 EXPLAIN 仅，禁止写入）

```sql
-- 1. 已下架 SKU 是否有近期销售（P0-09-01 影响半径）
SELECT sk.sku_id, sk.spec_name, sk.is_enabled, COUNT(si.sale_item_id) AS sold_count
FROM product_skus sk
JOIN sale_items si ON si.sku_id = sk.sku_id
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE sk.is_enabled = false
  AND so.created_at > NOW() - INTERVAL '30 days'
  AND so.status IN ('已支付','已完成','部分支付','待确认收款')
GROUP BY sk.sku_id, sk.spec_name, sk.is_enabled
ORDER BY sold_count DESC;

-- 2. 跨市场购买（P0-09-02 影响半径）
SELECT so.sale_order_id, so.store_id, sk.market_scope AS sku_market, sk.sku_id
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN stores st ON st.store_id = so.store_id
JOIN org_nodes mk ON st.org_node_id IN (
  SELECT id FROM org_nodes WHERE parent_id = mk.id AND type = '门店'
)
WHERE sk.market_scope IS NOT NULL
  AND mk.name <> sk.market_scope
  AND mk.type = '市场'
LIMIT 50;

-- 3. unit_price 与 sku.price 严重偏差（P1-09-04 三端写入分裂量化）
SELECT
  CASE
    WHEN ABS(si.unit_price - sk.price) < 0.01 THEN 'price_match'
    WHEN ABS(si.unit_price - COALESCE(sk.special_price, sk.price)) < 0.01 THEN 'special_match'
    ELSE 'mismatch'
  END AS price_class,
  COUNT(*)
FROM sale_items si
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE so.created_at > NOW() - INTERVAL '60 days'
  AND so.sale_order_type = '销售单'
GROUP BY 1;

-- 4. sale_amount ≠ unit_price * quantity 的脏行（P1-09-11）
SELECT sale_item_id, unit_price, quantity, sale_amount,
       (unit_price * quantity) AS expected
FROM sale_items
WHERE ABS(sale_amount - (unit_price * quantity)) > 0.01
ORDER BY created_at DESC LIMIT 50;

-- 5. mall_product_skus.bundle_price > productSkus.price 的反向加价行（P1-09-08）
SELECT mps.product_id, mps.sku_id, sk.price AS sku_price, mps.bundle_price
FROM mall_product_skus mps
JOIN product_skus sk ON sk.sku_id = mps.sku_id
WHERE mps.bundle_price IS NOT NULL
  AND mps.bundle_price > sk.price;

-- 6. productType 与 productKind 矛盾组合（P1-09-05）
SELECT pc.product_kind, sk.product_type, COUNT(*)
FROM product_skus sk
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE pc.product_kind IS NOT NULL
GROUP BY pc.product_kind, sk.product_type
ORDER BY pc.product_kind, sk.product_type;
```

---

## 8. 回归测试用例（建议）

1. **下架 SKU 不可下单**：admin 下架 SKU-X → staff/client/admin 三端用旧 skuId 调 order.create → 期望 `INVALID_PARAMS: SKU ... 已下架`
2. **跨市场 SKU 不可下单**：A 市场专享 SKU → B 市场顾客 / 店长 调 order.create → 期望 `INVALID_PARAMS: SKU 不在当前市场可售`
3. **deleteSku 事务原子性**：mock mall_product_skus.delete 返回成功但 productSkus.delete 抛错 → 期望 mall_product_skus 行被回滚
4. **sale_items.unit_price 三端一致**：staff/client/admin 同一 SKU 创建订单 → 期望三端 unit_price 字段写入值相同（要求确定语义后）
5. **bundle_price 上限**：admin 设 bundle_price = 10000 给 sku.price=500 → 期望 `INVALID_PARAMS`
6. **productType 与 productKind 联动校验**（如启用 CHECK）：尝试给 productKind='充值卡' 的分类下创建 productType='疗程卡' SKU → 期望失败
7. **mall_product_skus 删除时 priceFrom 取用正确**：套餐价 700 / 单价 800 / 特价 600 → 套餐场景显示 700，普通场景显示 600

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（P0-09-01 / P0-09-02 / P1-09-04 三端统一修复）
- 涉及历史数据：☑（P1-09-04 + P1-09-11 历史 sale_items 已存在分裂；valid_start/valid_end 引入需评估当前 sale_items.expire_date 兜底）
- 修复成本：M（含跨三端 SQL 拼装 + helper 抽取）

---

## 10. 后续待办

- [ ] 与 PM 对齐：valid_start / valid_end 是否仍需要（baseline reset 移除前 ticket 是否归档？）；若需要，在 SCHEMA-CHANGES 立 S09-1 ticket
- [ ] 与运营对齐 productKind 4 值的稳定性（动态 DB 驱动 vs 硬编码兜底取舍）
- [ ] 与财务对齐 sale_amount 写入语义（原价 × 数量 vs 优惠后 × 数量），明确审计口径，回填脏数据（CC1 横切汇总）
- [ ] order.create 三端校验 is_enabled / market_scope 的 sweep（参考 audit-02 / audit-05 已做的"事务外读 + partial unique 兜底"模式）
- [ ] 抽 `db/helpers/price-snapshot.ts` + `db/types/product-sku.dto.ts` 收敛三端 SKU 数据合约（与域 02 / 05 / 07 修复合并 epic）
- [ ] CROSS-CUTTING 命中：CC1 后端不重算前端值（admin createOrder unitPrice）；CC3 order.create 不校验 market_scope
- [ ] SCHEMA-CHANGES 提议：S09-1 ~ S09-5（见下文 SCHEMA-CHANGES.md 追加）
- [ ] ENUM-AUDIT 命中：E09-product-type, E09-product-kind（动态/枚举混合）
