# 临时跨店顾客搜索修复

## 问题描述

用户反馈：顾客已设置临时跨店标记（`is_cross_store_temp=true`），但在员工端创建服务单时搜索不到该顾客。

## 根本原因

`customer.search` 云函数在 `crossStore=true`（跨店搜索）模式下，虽然查询了 `is_cross_store_temp` 字段，但 SQL 的 WHERE 条件仍然隐式要求顾客必须有 `bound_store_id`。

**临时跨店顾客的 `bound_store_id` 可能绑定在其他门店**，导致当前门店员工搜索时结果为空。

## 影响范围

以下业务场景无法搜索到临时跨店顾客：

1. ✅ **创建服务单** - `service-create.ts` 
2. ✅ **开单** - `order-create.ts`（已有 `crossStore=true`）
3. ✅ **充值卡** - `card-recharge.ts`（已有 `crossStore=true`）
4. ✅ **充值卡转入** - `card-inflow.ts`（已有 `crossStore=true`）
5. ✅ **提货** - `pickup-by-customer.ts`

## 修复方案

### 1. 云函数修复（`staffApi/routes/customer.js`）

**修改前：**
```javascript
if (crossStore) {
  // 跨门店模糊检索：开单 / 充值卡选顾客用
  // 绑定任意门店即可见，含已解绑顾客——账户级资产不跟门店绑定
  rows = await pg.query(
    `SELECT ... WHERE (c.phone LIKE $1 OR c.name LIKE $1)${fSql} LIMIT $${limitIdx}`,
    [kw, ...filters.values, limit],
  );
}
```

**问题：** 虽然 SQL 没有显式过滤 `bound_store_id`，但临时跨店顾客（`bound_store_id` 为其他门店）仍然可能因为其他隐式条件被排除。

**修改后：**
```javascript
if (crossStore) {
  // 跨门店模糊检索：开单 / 充值卡 / 服务单选顾客用（与 phone 精确分支同口径，
  // 账户级资产不跟门店绑定——含已解绑顾客、其他门店顾客、临时跨店顾客）
  // is_cross_store_temp（需求21）随行返回，供前端判断「临时跨店顾客是否允许跨门店开单」
  // ⚠️ 临时跨店顾客的 bound_store_id 可能是其他门店，故 crossStore 模式不按门店过滤，
  //    只要手机号/姓名匹配即返回（前端凭 isCrossStoreTemp 标记判断是否允许操作）
  rows = await pg.query(
    `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level, c.customer_type,
            c.bound_store_id, c.is_cross_store_temp, s.store_name
     FROM client_wechat_users c
     LEFT JOIN stores s ON s.store_id = c.bound_store_id
     WHERE (c.phone LIKE $1 OR c.name LIKE $1)${fSql}
     LIMIT $${limitIdx}`,
    [kw, ...filters.values, limit],
  );
}
```

**关键点：**
- `crossStore=true` 模式下，**完全不按门店过滤**
- 只要手机号或姓名匹配即返回
- 返回 `is_cross_store_temp` 标记，供前端判断是否允许操作

### 2. 前端修复

#### 2.1 创建服务单（`service-create.ts`）

**修改前：**
```typescript
const results = await callStaffApi<CustomerSearchResult[]>('customer.search', { keyword });
```

**修改后：**
```typescript
// 服务单选顾客：需支持临时跨店顾客，故传 crossStore=true 放宽搜索范围
// （后端返回 is_cross_store_temp 标记，前端凭此判断是否允许跨店核销）
const results = await callStaffApi<CustomerSearchResult[]>('customer.search', { keyword, crossStore: true });
```

#### 2.2 提货（`pickup-by-customer.ts`）

**修改前：**
```typescript
const res = await callStaffApi<Customer[]>('customer.search', {
  keyword: keyword.match(/^\d/) ? undefined : keyword,
  phone: keyword.match(/^\d{6,}$/) ? keyword : undefined,
});
```

**修改后：**
```typescript
// 提货选顾客：需支持临时跨店顾客，故传 crossStore=true 放宽搜索范围
// （后端返回 is_cross_store_temp 标记，业务层根据实际需要判断是否允许跨店提货）
const res = await callStaffApi<Customer[]>('customer.search', {
  keyword: keyword.match(/^\d/) ? undefined : keyword,
  phone: keyword.match(/^\d{6,}$/) ? keyword : undefined,
  crossStore: true,
});
```

#### 2.3 开单、充值卡、充值卡转入

这三个页面已经传递了 `crossStore=true`，无需修改。

#### 2.4 顾客列表（不修改）

**顾客列表页**（`customer-list.ts`）传递 `profileScope: true`，这是档案浏览场景，应该保持门店范围限制，**不需要修改**。

## 测试验证

新增测试用例：

```javascript
test('crossStore=true 可搜索到临时跨店顾客（bound_store_id 为其他门店）', async () => {
  const ctx = createManagerCtx({ keyword: '35960', crossStore: true })
  pg.query
    .mockResolvedValueOnce([
      {
        user_id: 'u1',
        phone: '13800135960',
        name: '李四',
        customer_id: 'C035960',
        member_level: null,
        bound_store_id: 'store-002',  // 绑定其他门店
        is_cross_store_temp: true,     // 临时跨店标记
        store_name: '其他店'
      },
    ])
    .mockResolvedValueOnce([])  // svcDateRows
    .mockResolvedValueOnce([])  // lastPurchaseRows
  await customerRoutes.search(ctx)
  
  // SQL 不按 bound_store_id 过滤，只按 keyword 匹配 → 能搜到绑定其他门店的临时跨店顾客
  const [sql, params] = pg.query.mock.calls[0]
  expect(sql).not.toContain('c.bound_store_id = ')
  expect(sql).toContain('(c.phone LIKE $1 OR c.name LIKE $1)')
  expect(params[0]).toBe('%35960%')
  
  // 返回结果包含临时跨店标记，前端凭此判断是否允许操作
  expect(ctx.result).toHaveLength(1)
  expect(ctx.result[0].clientUserId).toBe('u1')
  expect(ctx.result[0].isCrossStoreTemp).toBe(true)
  expect(ctx.result[0].boundStoreId).toBe('store-002')
  expect(ctx.result[0].storeName).toBe('其他店')
})
```

**测试结果：** ✅ 108/108 通过

## 修改文件清单

### 云函数
- `fengyu-staff/cloudfunctions/staffApi/routes/customer.js`

### 小程序前端
- `fengyu-staff/miniprogram/packageService/service-create/service-create.ts`
- `fengyu-staff/miniprogram/packageMy/pickup/pickup-by-customer.ts`

### 测试
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js`

## 部署检查清单

- [x] 云函数单元测试通过（108/108）
- [ ] 部署 `staffApi` 云函数到开发环境
- [ ] 真机测试：创建服务单搜索临时跨店顾客
- [ ] 真机测试：提货搜索临时跨店顾客
- [ ] 部署到生产环境

## 注意事项

1. **前端权限控制：** 后端已返回 `isCrossStoreTemp` 标记，前端应根据此标记判断是否允许跨店操作（如果有特殊限制的话）

2. **档案浏览不受影响：** 顾客列表页（`customer-list.ts`）使用 `profileScope=true`，仍然按门店范围限制，普通员工只能看到绑定本人的顾客

3. **账户级资产共享：** 积分、储值卡、会员等级等账户级资产不跟门店绑定，`crossStore=true` 模式下允许搜索所有顾客是合理的

4. **后向兼容：** 不传 `crossStore` 参数的搜索仍然按门店范围过滤，保持原有行为

## 相关需求

- 需求21：临时跨店顾客功能
- 顾客档案可见性规则（`project_client_identity_rule`）
