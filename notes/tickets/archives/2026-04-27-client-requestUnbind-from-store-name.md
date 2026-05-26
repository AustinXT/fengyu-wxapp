# Ticket: client requestUnbind 写入不存在的 from_store_name 列 — 顾客解绑流 100% 失效

> 生成日期：2026-04-27
> 实施状态：🟡 部分修复（INSERT/SELECT 已修正；测试夹具待同步）

## 一句话背景

`store_unbind_requests` 表只有 `from_store_id text NOT NULL REFERENCES stores(store_id)` 列，无 `from_store_name`。clientApi `requestUnbind` 原先 INSERT 写入 `from_store_name` → PG 42703 列不存在错误 → 顾客端"申请解绑门店"按钮 100% 不可用。

## 影响范围

| 维度 | 说明 |
|------|------|
| **严重级别** | P0（功能完全失效） |
| **端** | fengyu-client（clientApi 云函数 + 测试夹具） |
| **来源** | P0-12-01 / P0-CC9-03（代码引用已删 schema 字段模式） |
| **关联 audit** | [audit-12 §3.1](../../docs/audit/audit-12-store-binding.md)、[SUMMARY #7](../../docs/audit/SUMMARY.md)、横切模式"代码引用已删 schema 字段"（5-sku_id / 12-from_store_name / 14-store_id / 09-valid_start） |
| **用户影响** | 顾客无法自助解绑门店，必须联系店长/客服手动处理 |

## 根因分析

| 文件 | 原代码（bug） | 修复后 |
|------|-------------|--------|
| `clientApi/routes/store.js:155-159` | `INSERT INTO store_unbind_requests (..., from_store_name, ...)` | ✅ 已改为 `from_store_id` |
| `clientApi/routes/store.js:174-180` | `SELECT from_store_name FROM store_unbind_requests` | ✅ 已改为 `LEFT JOIN stores` 取别名 |
| `clientApi/__tests__/routes/store.test.js:111` | mock 返回 `from_store_name: '凤御A店'` | ❌ **未修**：仍用旧列名 |

### Schema 权威定义

文件 `db/schema/store-unbind.ts`：
```
fromStoreId: text('from_store_id').notNull().references(() => stores.storeId)
```
无 `from_store_name` 列。

## 当前修复状态

| 项 | 状态 | 说明 |
|----|------|------|
| INSERT 语句 | ✅ 已修复 | `from_store_id` + 参数 `boundStoreId` |
| SELECT 语句 | ✅ 已修复 | `LEFT JOIN stores s ON s.store_id = r.from_store_id`，`s.store_name AS from_store_name` 作 SQL 别名 |
| 测试夹具 | ❌ 未修 | `store.test.js:111` 仍 mock `from_store_name`；测试假绿，锁死旧列名 |

## 待完成修复

### 1. 测试夹具同步（store.test.js）

```javascript
// 第 111 行，改为：
request_id: 'req-1', from_store_id: 'store-1'
```

同时检查 mock SQL 返回是否需配合 LEFT JOIN 结构调整（测试应返回 `from_store_id`，JOIN 后的 `from_store_name` 由 SQL 别名产生）。

### 2. 测试反向锁死整治

这是 audit-CC9 反模式：测试 mock 锁死了已删字段名。修复后应确保：
- mock 只返回 schema 中真实存在的列
- JOIN 产生的别名列在 mock 中也正确模拟

### 3. 同模式扫描

同一横切模式"代码引用已删 schema 字段"涉及 4 个域：

| 域 | 已删字段 | 状态 |
|----|---------|------|
| 05 服务单 | `sku_id` | P0-05-01 |
| 12 解绑 | `from_store_name` | 本 ticket |
| 14 充值卡 | `store_id` | P0-14-01 |
| 09 商品 | `valid_start` / `valid_end` | — |

建议统一 grep 确认所有已删字段引用已清理。

## 复现路径（修复前）

1. 顾客在 `pages/me/index` 点击"申请解绑"
2. 调用 `wx.cloud.callFunction({name:'clientApi', data:{action:'store.requestUnbind', payload:{note:'搬家'}}})`
3. 云函数日志：`column "from_store_name" of relation "store_unbind_requests" does not exist`
4. UI toast 显示"服务器内部错误"

## 验收标准

- [ ] `store.test.js` mock 不再包含 `from_store_name` 列名（改为 `from_store_id`）
- [ ] `clientApi/__tests__/` 全部测试通过
- [ ] `grep -r 'from_store_name' fengyu-client/cloudfunctions/` 仅剩 `s.store_name AS from_store_name`（SQL JOIN 别名，合法）
- [ ] 生产环境 requestUnbind 可正常提交解绑申请

## 关联

| 关联项 | 关系 |
|--------|------|
| [SUMMARY E3 已删字段清理](../../docs/audit/SUMMARY.md) | 本 ticket 属 E3 epic |
| [audit-12 P0-12-01](../../docs/audit/audit-12-store-binding.md) | 原始审计发现 |
| [audit-CC9 测试反向锁死](../../docs/audit/audit-CC9-test-migration-residue.md) | 测试夹具反模式 |
| [P0-05-01 sku_id](../../docs/audit/audit-05-service-order.md) | 同模式（已删字段引用） |
| [P0-14-01 store_id](../../docs/audit/audit-14-prepaid-card.md) | 同模式（已删字段引用） |
