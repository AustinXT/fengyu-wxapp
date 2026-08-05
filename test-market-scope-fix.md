# 商城可见范围修复验证

## 问题描述
商城管理中，取消所有市场的可见范围勾选并保存后，刷新页面仍然显示勾选了全部市场。

## 修复内容

### 语义定义
- `market_scope = NULL` → 全部市场可见
- `market_scope = ''` → 不可见于任何市场
- `market_scope = 'id1,id2'` → 仅指定市场可见

### 代码修改
1. 保存逻辑：`allMarkets ? null : (selectedMarketIds.length > 0 ? join : "")`
2. 初始化逻辑：`allMarkets = marketScope === null`

### 修改文件
- fengyu-admin/src/app/(main)/mall/[id]/_components/product-detail-page.tsx
- fengyu-admin/src/app/(main)/mall/create/_components/product-create-page.tsx
- fengyu-admin/src/app/(main)/products/[id]/_components/product-detail-page.tsx
- fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx

## 验证步骤

### 1. 验证商品详情页
```bash
# 启动 admin 开发服务器
cd fengyu-admin
npm run dev
```

访问：http://localhost:3000/mall/prod-1784612727227

#### 测试场景 A：全部市场 → 空选择
1. 初始状态：勾选"全部市场"
2. 操作：取消"全部市场"勾选，不勾选任何单个市场
3. 点击"保存"
4. 刷新页面
5. **预期**：不勾选"全部市场"，也不勾选任何单个市场
6. **数据库验证**：`market_scope = ''`

#### 测试场景 B：空选择 → 全部市场
1. 初始状态：不勾选任何市场（market_scope = ''）
2. 操作：勾选"全部市场"
3. 点击"保存"
4. 刷新页面
5. **预期**：勾选"全部市场"
6. **数据库验证**：`market_scope IS NULL`

#### 测试场景 C：空选择 → 部分市场
1. 初始状态：不勾选任何市场（market_scope = ''）
2. 操作：勾选"南昌凤仪韵"
3. 点击"保存"
4. 刷新页面
5. **预期**：不勾选"全部市场"，只勾选"南昌凤仪韵"
6. **数据库验证**：`market_scope = 'org-市场-...'`

### 2. 验证数据库
```sql
-- 查看修改前的状态
SELECT product_id, name, 
  CASE 
    WHEN market_scope IS NULL THEN 'NULL (全部可见)'
    WHEN market_scope = '' THEN 'EMPTY (不可见)'
    ELSE market_scope 
  END as scope_status
FROM products 
WHERE product_id = 'prod-1784612727227';

-- 测试场景 A 后应该看到
-- market_scope = '' 

-- 测试场景 B 后应该看到
-- market_scope IS NULL

-- 测试场景 C 后应该看到
-- market_scope = 'org-市场-1779767525664' (或其他市场 ID)
```

### 3. 验证创建页面
访问：http://localhost:3000/mall/create

1. 默认勾选"全部市场"
2. 取消勾选
3. 创建商品
4. 查看商品详情页，应该不勾选"全部市场"

## 预期结果

✅ 取消所有市场勾选后保存，market_scope 保存为空字符串 ''
✅ 刷新页面后，"全部市场"不勾选，单个市场也都不勾选
✅ 勾选"全部市场"后保存，market_scope 保存为 NULL
✅ 勾选部分市场后保存，market_scope 保存为逗号分隔的 ID

## 回归风险

### 低风险
- 仅修改前端保存和初始化逻辑
- 数据库 schema 未变更
- 后端 action 函数未变更
- 类型定义 `string | null` 已包含空字符串

### 需要注意
如果其他地方有查询逻辑依赖 `market_scope`，需要确保能正确处理空字符串：
- 筛选"全部市场可见"的商品：`WHERE market_scope IS NULL`
- 筛选"不可见"的商品：`WHERE market_scope = ''`
- 筛选"指定市场可见"的商品：`WHERE market_scope IS NOT NULL AND market_scope != ''`
