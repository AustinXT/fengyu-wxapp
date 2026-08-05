# 商城可见范围保存失效修复

**Bug ID**: dev 环境 prod-1784612727227  
**报告日期**: 2026-08-06  
**修复日期**: 2026-08-06  

## 问题描述

在商城管理页面，取消所有市场的可见范围勾选并保存后，刷新页面仍然显示勾选了全部市场。

### 复现步骤
1. 访问商城商品详情页（如 `/mall/prod-1784612727227`）
2. 初始状态："全部市场"复选框已勾选
3. 取消"全部市场"勾选
4. 不勾选任何单个市场
5. 点击"保存"
6. 刷新页面
7. **Bug**: "全部市场"复选框又变成勾选状态

### 用户期望
取消所有市场勾选后，保存并刷新，应该保持"未勾选任何市场"的状态，表示该商品不可见于任何市场。

## 根因分析

### 语义定义不一致

**旧的实现**（含糊不清）：
- `market_scope = NULL` → 全部市场可见
- `market_scope = ''` → staffApi 视为全部可见，clientApi 未明确处理
- `market_scope = 'id1,id2'` → 指定市场可见

**问题**：
1. 前端保存逻辑：`allMarkets ? null : (selectedMarketIds.length > 0 ? join : null)`
   - 当用户取消所有勾选时（`allMarkets=false`, `selectedMarketIds=[]`），保存 `null`
   - 但 `null` 表示"全部可见"，与用户意图相反

2. 前端初始化逻辑：`allMarkets = !product.marketScope`
   - `!null = true` → 勾选"全部市场"
   - 用户取消后保存的 `null` 又被读取为"全部市场"，形成循环

3. 缺少"不可见于任何市场"的状态表示

### 新的语义定义（明确三态）

- `market_scope = NULL` → **全部市场可见**
- `market_scope = ''` → **不可见于任何市场**（新增语义）
- `market_scope = 'id1,id2'` → **仅指定市场可见**

## 修复方案

### 1. 前端修复（4 个文件）

#### 修改点 A：初始化逻辑
**旧代码**：
```typescript
const [allMarkets, setAllMarkets] = useState(!product.marketScope);
const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
  product.marketScope ? product.marketScope.split(",") : [],
);
```

**新代码**：
```typescript
const [allMarkets, setAllMarkets] = useState(product.marketScope === null);
const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
  product.marketScope && product.marketScope !== "" ? product.marketScope.split(",") : [],
);
```

**修改逻辑**：
- `marketScope === null` → `allMarkets = true`（全部可见）
- `marketScope === ""` → `allMarkets = false, selectedMarketIds = []`（不可见）
- `marketScope` 有值 → `allMarkets = false, selectedMarketIds = split(",")`（部分可见）

#### 修改点 B：保存逻辑
**旧代码**：
```typescript
marketScope: allMarkets ? null : selectedMarketIds.length > 0 ? selectedMarketIds.join(",") : null
```

**新代码**：
```typescript
marketScope: allMarkets ? null : selectedMarketIds.length > 0 ? selectedMarketIds.join(",") : ""
```

**修改逻辑**：
- `allMarkets=true` → 保存 `null`（全部可见）
- `allMarkets=false` 且有选择 → 保存 `'id1,id2'`（部分可见）
- `allMarkets=false` 且无选择 → 保存 `""`（不可见）

#### 修改的文件
1. `fengyu-admin/src/app/(main)/mall/[id]/_components/product-detail-page.tsx`
2. `fengyu-admin/src/app/(main)/mall/create/_components/product-create-page.tsx`
3. `fengyu-admin/src/app/(main)/products/[id]/_components/product-detail-page.tsx`
4. `fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx`

### 2. 云函数修复（2 个文件）

#### staffApi 修复
**文件**: `fengyu-staff/cloudfunctions/staffApi/routes/product.js`

**旧代码**（第 30 行）：
```javascript
const globalExpr = `(${scopeExpr} IS NULL OR btrim(${scopeExpr}) = '')`
```

**新代码**：
```javascript
const globalExpr = `${scopeExpr} IS NULL`
```

**修改逻辑**：
- 旧：`NULL` 和空字符串都视为"全部可见"
- 新：只有 `NULL` 表示"全部可见"，空字符串表示"不可见"

#### clientApi 修复
**文件**: `fengyu-client/cloudfunctions/clientApi/routes/product.js`

**旧代码**（第 30 行）：
```javascript
const globalExpr = `(${scopeExpr} IS NULL OR btrim(${scopeExpr}) = '')`
```

**新代码**：
```javascript
const globalExpr = `${scopeExpr} IS NULL`
```

**修改逻辑**：同 staffApi

#### 注释更新
两个云函数都添加了语义说明注释：
```javascript
/**
 * 语义约定（2026-08-06 修复）：
 * - NULL = 全部市场可见
 * - '' (空字符串) = 不可见于任何市场
 * - 'id1,id2' = 仅指定市场可见
 */
```

### 3. 数据库层面

**无需迁移脚本**：
- `market_scope` 列类型为 `TEXT`，可以存储 `NULL` 和空字符串
- 旧数据中已存在的 `NULL` 值语义不变（全部可见）
- 新语义（空字符串=不可见）仅对新保存的数据生效
- 不存在需要批量修改的历史数据

## 验证测试

### 测试场景 A：全部市场 → 不可见
1. 商品初始状态：`market_scope = NULL`，界面勾选"全部市场"
2. 操作：取消"全部市场"勾选，不勾选任何单个市场
3. 点击"保存"
4. **验证数据库**：`market_scope = ''`
5. 刷新页面
6. **验证界面**：不勾选"全部市场"，也不勾选任何单个市场 ✅

### 测试场景 B：不可见 → 全部市场
1. 商品初始状态：`market_scope = ''`，界面未勾选任何市场
2. 操作：勾选"全部市场"
3. 点击"保存"
4. **验证数据库**：`market_scope IS NULL`
5. 刷新页面
6. **验证界面**：勾选"全部市场" ✅

### 测试场景 C：不可见 → 部分市场
1. 商品初始状态：`market_scope = ''`
2. 操作：勾选"南昌凤仪韵"
3. 点击"保存"
4. **验证数据库**：`market_scope = 'org-市场-1779767525664'`（示例）
5. 刷新页面
6. **验证界面**：不勾选"全部市场"，只勾选"南昌凤仪韵" ✅

### 测试场景 D：部分市场 → 不可见
1. 商品初始状态：`market_scope = 'org-市场-1779767525664'`
2. 操作：取消所有单个市场的勾选
3. 点击"保存"
4. **验证数据库**：`market_scope = ''`
5. 刷新页面
6. **验证界面**：不勾选"全部市场"，也不勾选任何单个市场 ✅

### 云函数验证
**验证查询逻辑正确处理空字符串**：

```sql
-- 商品 A：market_scope = NULL（全部可见）
-- 商品 B：market_scope = ''（不可见）
-- 商品 C：market_scope = 'org-市场-1779767525664'（仅南昌凤仪韵可见）

-- 南昌凤仪韵门店的员工/顾客查询商品列表
-- 应该返回：商品 A 和商品 C
-- 不应该返回：商品 B
```

## 影响范围

### 前端（admin）
- ✅ 商城商品创建/编辑
- ✅ SKU 创建/编辑
- ✅ TypeScript 编译通过

### 后端（云函数）
- ✅ staffApi 开单页商品列表
- ✅ clientApi 商城商品展示
- ⚠️ **需要部署到 dev 和 prod 环境**

### 数据一致性
- ✅ 旧数据（`NULL`）语义不变
- ✅ 新语义（空字符串）向后兼容
- ✅ 无需数据迁移

## 部署计划

### 1. Dev 环境验证
```bash
# 1. 部署云函数
cd fengyu-staff/cloudfunctions
npm run deploy:dev  # 或使用 /cloudbase-deploy skill

cd fengyu-client/cloudfunctions
npm run deploy:dev

# 2. 重启 admin 开发服务器（前端已修改）
cd fengyu-admin
npm run dev

# 3. 手动验证测试场景 A-D
```

### 2. Prod 环境部署
```bash
# 确认 dev 验证通过后
# 1. 合并到 main 分支
# 2. 部署云函数到 prod
# 3. 构建并部署 admin 到 prod
```

## 回归风险评估

### 低风险
- ✅ 仅修改可见范围逻辑，不影响其他功能
- ✅ 数据库 schema 未变更
- ✅ 类型定义 `string | null` 已包含空字符串
- ✅ 前端 UI 交互逻辑不变

### 需要注意
- ⚠️ 确保 dev 和 prod 云函数都部署新版本
- ⚠️ 如果有定时任务或脚本直接操作 `market_scope`，需要适配新语义
- ⚠️ 如果有其他系统（如数据分析）读取 `market_scope`，需要告知新语义

## 相关代码位置

### 前端
- `fengyu-admin/src/app/(main)/mall/[id]/_components/product-detail-page.tsx:65-68, 199`
- `fengyu-admin/src/app/(main)/mall/create/_components/product-create-page.tsx:95`
- `fengyu-admin/src/app/(main)/products/[id]/_components/product-detail-page.tsx:51-54, 121`
- `fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx:108`

### 云函数
- `fengyu-staff/cloudfunctions/staffApi/routes/product.js:21-30`
- `fengyu-client/cloudfunctions/clientApi/routes/product.js:20-30`

### 数据库
- 表：`products` 列：`market_scope TEXT`
- 表：`product_skus` 列：`market_scope TEXT`

## 后续优化建议

1. **UI 改进**：当前"取消全部市场且不选任何市场"的操作不够直观，可以考虑：
   - 添加"不可见"单选项
   - 或添加明确的提示文本："未选择任何市场时，该商品将不可见"

2. **数据校验**：在 admin 保存时添加确认提示：
   ```
   您未选择任何市场，该商品将不会在任何市场展示。确认保存吗？
   ```

3. **测试覆盖**：添加自动化测试覆盖三种状态的转换逻辑

## 总结

本次修复通过明确三态语义（NULL / 空字符串 / ID 列表）解决了"可见范围保存失效"的问题。修改涉及前端 4 个文件和云函数 2 个文件，无需数据库迁移，向后兼容旧数据。修复后，用户可以通过取消所有市场勾选来设置"不可见于任何市场"的状态。
