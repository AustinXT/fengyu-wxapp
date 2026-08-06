# 转换单梯度累加价格修复

## 问题描述

转换单未实现疗程卡的梯度累加计价逻辑，导致：
- **销售单应付合计**：¥18,430.00（应用了梯度累加）
- **转换单转入合计**：¥18,994.00（未应用梯度累加）
- **差额**：¥564（多收了）

## 根本原因

### 前端 (order-create.ts)

在 `updateCart` 函数中，梯度累加价格（`tierLineMap`）只在 `isSales`（销售单）时计算：

```typescript
const tierLineMap = isSales
  ? buildTreatmentTierLineMap(cart, this._allSkus, this.data.buyerIsMember)
  : new Map<string, number>();
```

转换单（`saleOrderType === '转换单'`）被排除在外，导致按标准价 `price × quantity` 计算，而不是梯度累加价。

### 后端 (order.js)

在 `createConversion` 函数中：
1. **`applyTreatmentTierPricing` 函数**只支持销售单：
   ```javascript
   if (saleOrderType !== '销售单') return
   ```

2. **转换单创建逻辑**根本没有调用 `applyTreatmentTierPricing`，直接按 SKU 单价 × 数量计算。

## 修复方案

### 1. 前端修复 (fengyu-staff/miniprogram/pages/order-create/order-create.ts)

**位置**：`updateCart` 函数（第 1074-1083 行）

**修改**：
```typescript
// 修改前
const supportsManagerSpecial = isSales || saleOrderType === '转换单';
const tierLineMap = isSales
  ? buildTreatmentTierLineMap(cart, this._allSkus, this.data.buyerIsMember)
  : new Map<string, number>();

// 修改后
const isConversion = saleOrderType === '转换单';
const supportsManagerSpecial = isSales || isConversion;
// 销售单 + 转换单均需计算疗程卡梯度累加价（寄存单/内部单不计算）
const tierLineMap = (isSales || isConversion)
  ? buildTreatmentTierLineMap(cart, this._allSkus, this.data.buyerIsMember)
  : new Map<string, number>();
```

### 2. 后端修复 (fengyu-staff/cloudfunctions/staffApi/routes/order.js)

#### 2.1 修改 `applyTreatmentTierPricing` 函数（第 110-111 行）

```javascript
// 修改前
function applyTreatmentTierPricing(rawItems, tierSkuRows, buyerIsMember, saleOrderType) {
  if (saleOrderType !== '销售单') return

// 修改后
function applyTreatmentTierPricing(rawItems, tierSkuRows, buyerIsMember, saleOrderType) {
  // 销售单 + 转换单均需计算疗程卡梯度累加价（寄存单/内部单不计算）
  if (saleOrderType !== '销售单' && saleOrderType !== '转换单') return
```

#### 2.2 增强 `createConversion` 函数（第 3386-3445 行）

**关键改动**：

1. **查询 SKU 时增加 `category_id`**（梯度累加需要按分类+名称分组）
2. **构建 `inItems` 时增加必要字段**：
   - `categoryId`：用于梯度分组
   - `saleAmount`：初始值等于 `amount`
   - `manualSaleAmountOverride`：标记店长特价，梯度累加会跳过这些行

3. **应用梯度累加逻辑**（新增第 2.5 步）：
   ```javascript
   // 2.5. 转入项目应用疗程卡梯度累加价（与销售单对齐）
   // 查询所有可能用于梯度计算的 SKU（同分类+同名称的所有疗程卡规格）
   const tierSkuIds = new Set()
   for (const item of inItems) {
     if (item.productType === '疗程卡' && item.categoryId && !item.isExperience && !item.manualSaleAmountOverride) {
       tierSkuIds.add(item.categoryId + '::' + item.productName)
     }
   }
   let tierSkuRows = []
   if (tierSkuIds.size > 0) {
     const categoryIds = [...new Set(inItems.map(i => i.categoryId).filter(Boolean))]
     const tierSkuRes = await tx.query(
       `SELECT s.sku_id, s.category_id, s.spec_name, s.product_type, s.price, s.special_price,
               s.session_count, s.is_experience, s.is_manager_special
        FROM product_skus s
        WHERE s.category_id = ANY($1) AND s.product_type = '疗程卡' AND s.deleted_at IS NULL`,
       [categoryIds]
     )
     tierSkuRows = tierSkuRes.rows
   }
   applyTreatmentTierPricing(inItems, tierSkuRows, buyerIsMember, '转换单')

   // 重新计算 totalIn（梯度累加可能改变了 amount / saleAmount）
   let totalIn = 0
   for (const item of inItems) {
     totalIn += Number(item.saleAmount) || Number(item.amount) || 0
   }
   ```

4. **`totalIn` 计算延后**：从循环内累加改为应用梯度累加后统一计算。

## 测试验证

### 前端
- ✅ TypeScript 类型检查通过（`npx tsc --noEmit`）
- 转换单选择商品后，价格应与销售单一致

### 后端
- 需要部署后测试转换单创建
- 验证转换单的 `total_amount` 与前端展示的"转入合计"一致

## 影响范围

### 修改的订单类型
- ✅ 销售单：无影响（原本就支持）
- ✅ 转换单：**修复后支持梯度累加**
- ✅ 内部单：无影响（不应用梯度累加）
- ✅ 寄存单：无影响（不应用梯度累加）

### 梯度累加逻辑规则（不变）
- **仅疗程卡**：`product_type === '疗程卡'`
- **排除体验卡**：`is_experience !== true`
- **排除店长特价**：`is_manager_special !== true` 或无手填金额
- **排除套餐行**：`refBundleId` 为空
- **按分类+名称分组**：`categoryId + '::' + productName`
- **总次数 > 1**：同组所有行的总次数必须 > 1
- **选最优阶梯**：次数最大且单次价最低的规格

## 部署说明

### 前端
- 使用微信开发者工具重新编译 `fengyu-staff/miniprogram`
- 上传并发布小程序

### 后端
- 运行 `scripts/deploy-cloudfunctions.sh` 部署 `staffApi` 云函数
- 验证环境变量（`PG_CONNECTION_STRING` 等）

## 相关文档
- `.42cog/pm/backend.pr.spec.md` — 后端产品需求（转换单规范）
- `.42cog/cog.md` — 业务认知模型（会员价梯度累加规则）
- `fengyu-staff/miniprogram/utils/cart-calc.ts` — 前端梯度累加工具函数
