# 员工端切换门店缓存问题修复报告

**修复日期**：2026-08-06  
**问题编号**：P1 - 数据错乱风险  
**影响范围**：员工端门店视图

---

## 问题概述

### 核心问题
员工端切换门店后，开单页的商品列表仍保留旧门店数据，导致：
1. **下单风险**：员工可能下单不属于当前市场的商品
2. **数据错乱**：订单关联错误的门店/市场
3. **用户困惑**：看到不属于当前门店的商品/顾客

### 根本原因
开单页 (`order-create.ts`) 未监听 `EVENT_STORE_CHANGED` 事件，导致以下缓存未及时清理：
- `_allSkus` / `_experienceSkus` — SKU 列表（**核心问题**）
- `_allCategories` / `_allGroupedCategories` — 商品分类
- `_spuCache` — 商品展示缓存
- `bundleSpus` — 组合套餐
- `cart` — 购物车（可能混入跨门店商品）
- `customerInfo` — 已选顾客（可能不属于新门店）
- `selectedCoupon` — 已选优惠券（券与门店/顾客绑定）

---

## 修复方案

### 1. 开单页 (order-create.ts)

#### 变更 1：添加事件订阅
```typescript
// 导入 event-bus
import { on, EVENT_STORE_CHANGED } from '../../utils/event-bus';

// onLoad 生命周期添加订阅
onLoad() {
  this._unsubscribeStoreChange = on(EVENT_STORE_CHANGED, (storeId: string) => {
    console.log('[order-create] 门店已切换:', storeId, '→ 清空商品缓存 + 购物车');
    this.onStoreChanged();
  });
}

// onUnload 生命周期添加取消订阅
onUnload() {
  if (this._unsubscribeStoreChange) this._unsubscribeStoreChange();
  if (this._kwTimer) clearTimeout(this._kwTimer);
}

_unsubscribeStoreChange: null as (() => void) | null,
```

#### 变更 2：新增 onStoreChanged 方法
```typescript
/**
 * 门店切换后的清理与刷新（2026-08-06 新增）
 *
 * 切换门店时需要完全重置的数据：
 * 1. 商品目录缓存（不同门店的商品/分类/SKU 不同，必须重新加载）
 * 2. 购物车（防止跨门店混单，避免下单不属于当前市场的商品）
 * 3. 已选顾客（顾客可能不属于新门店，需重新搜索确认）
 * 4. 优惠券（券与顾客/门店绑定，切换后失效）
 * 5. 结算表单的所有临时状态
 */
onStoreChanged() {
  // 1. 清空商品目录缓存（强制重新从云端拉取新门店的商品数据）
  this._allCategories = [];
  this._allGroupedCategories = [];
  this._allSkus = [];
  this._experienceSkus = [];
  this._spuCache = {};

  // 2. 完全重置开单状态（购物车 + 结算表单 + 商品类型 Tab）
  this.resetOrderState();

  // 3. 重新加载新门店的商品目录
  this.loadShopInit();

  // 4. Toast 提示用户（避免用户困惑为何购物车清空）
  wx.showToast({
    title: '已切换门店，购物车已清空',
    icon: 'none',
    duration: 2000,
  });
}
```

### 2. 全局数据 (app.ts)

#### 变更：切换门店时清除最近顾客缓存
```typescript
setCurrentStoreId(storeId) {
  const oldStoreId = this.globalData.currentStoreId;
  this.globalData.currentStoreId = storeId || '';
  wx.setStorageSync('currentStoreId', storeId || '');

  // 2026-08-06：切换门店时清除「最近顾客」缓存，防止跨门店顾客串用
  if (oldStoreId && oldStoreId !== storeId) {
    wx.removeStorageSync('recentCustomers');
    console.log('[setCurrentStoreId] 门店已切换，清除最近顾客缓存');
  }
}
```

---

## 深度分析：需要重置的数据清单

### 一级影响（已修复）

| 数据类型 | 位置 | 风险等级 | 修复状态 |
|---------|------|---------|---------|
| 商品 SKU 列表 | `order-create.ts` `_allSkus` | **P0 - 严重** | ✅ 已修复 |
| 体验卡 SKU | `order-create.ts` `_experienceSkus` | **P0 - 严重** | ✅ 已修复 |
| 商品分类 | `order-create.ts` `_allCategories` | **P0 - 严重** | ✅ 已修复 |
| 商品展示缓存 | `order-create.ts` `_spuCache` | **P0 - 严重** | ✅ 已修复 |
| 组合套餐 | `order-create.ts` `bundleSpus` | **P1 - 高** | ✅ 已修复 |
| 购物车 | `order-create.ts` `cart` | **P0 - 严重** | ✅ 已修复 |
| 已选顾客 | `order-create.ts` `customerInfo` | **P1 - 高** | ✅ 已修复 |
| 已选优惠券 | `order-create.ts` `selectedCoupon` | **P1 - 高** | ✅ 已修复 |
| 最近顾客列表 | `app.ts` storage | **P1 - 高** | ✅ 已修复 |

### 二级影响（无需修复 - 按门店实时查询）

以下页面每次 onShow 都会重新请求云端数据，天然按当前门店过滤，无缓存问题：

| 页面 | 数据来源 | 是否需要修复 | 原因 |
|------|---------|------------|------|
| 服务列表 | `service.list` API | ❌ 无需修复 | 每次 onShow 实时查询，云端按 currentStoreId 过滤 |
| 订单列表 | `order.list` API | ❌ 无需修复 | 每次 onShow/tab 切换实时查询，无缓存 |
| 预约列表 | `appointment.list` API | ❌ 无需修复 | 每次 onShow 实时查询 |
| 工作台 | `staff.todayCommission` API | ❌ 无需修复 | 已监听 `EVENT_STORE_CHANGED`，切换后自动刷新 |
| 我的页面 | `profile.ts` | ❌ 无需修复 | 已监听 `EVENT_STORE_CHANGED`，仅显示信息 |

### 三级影响（业务约束保护）

| 场景 | 保护机制 | 是否需要额外修复 |
|------|---------|----------------|
| 跨门店顾客开单 | 云函数 `order.create` 校验 `boundStoreId` | ❌ 无需修复 |
| 不属于市场的商品 | 云函数按 `currentStoreId` 查询商品 | ❌ 无需修复 |
| 优惠券跨门店使用 | 云函数 `coupon.available` 按顾客+门店过滤 | ❌ 无需修复 |

---

## 测试验证方案

### 手动测试清单

#### 测试场景 1：切换门店后开单
**前置条件**：
- 员工有 2 个以上门店权限（`scopedStores.length >= 2`）
- 门店 A 和门店 B 有不同的商品/市场

**测试步骤**：
1. 登录员工端，默认进入门店 A
2. 进入「开单」Tab，加载门店 A 的商品列表
3. 添加门店 A 的某个商品到购物车（例如：护理类商品 X）
4. 切换到「我的」或「工作台」Tab
5. 点击门店选择器，切换到门店 B
6. 返回「开单」Tab

**预期结果**：
- ✅ Toast 提示：「已切换门店，购物车已清空」
- ✅ 购物车为空（商品 X 已清除）
- ✅ 商品列表显示门店 B 的商品
- ✅ 侧边栏分类显示门店 B 的分类
- ✅ 选择商品 Y（门店 B 特有）可以正常加入购物车

**失败标准**：
- ❌ 购物车仍显示门店 A 的商品 X
- ❌ 商品列表仍显示门店 A 的商品
- ❌ 下单时提交的商品不属于当前门店的市场

#### 测试场景 2：切换门店后最近顾客清空
**测试步骤**：
1. 在门店 A 开单，搜索并选择顾客「张三」（绑定门店 A）
2. 开单成功后，「张三」进入最近顾客列表
3. 切换到门店 B
4. 再次进入开单页，查看最近顾客列表

**预期结果**：
- ✅ 最近顾客列表为空（「张三」已清除）

**失败标准**：
- ❌ 仍显示「张三」，且点击后可能跨门店开单

#### 测试场景 3：切换门店后优惠券失效
**测试步骤**：
1. 在门店 A 开单，选择顾客「李四」，添加商品，选择优惠券「满减券 A」
2. 不提交订单，切换到门店 B
3. 返回开单页

**预期结果**：
- ✅ 购物车已清空
- ✅ 已选优惠券已清空
- ✅ 已选顾客已清空

#### 测试场景 4：多次切换门店
**测试步骤**：
1. 门店 A → 开单（添加商品 X）
2. 切换到门店 B → 验证商品 X 已清空，加载门店 B 商品
3. 切换回门店 A → 验证门店 B 商品已清空，重新加载门店 A 商品
4. 重复步骤 2-3 三次

**预期结果**：
- ✅ 每次切换都触发清空+重新加载
- ✅ 无串数据
- ✅ 无性能问题（loadShopInit 有 loading 态）

### 自动化测试建议

#### 单元测试（可选）
```typescript
// fengyu-staff/miniprogram/__tests__/order-create.test.ts
describe('order-create 门店切换', () => {
  it('切换门店后清空商品缓存', () => {
    // 模拟 loadShopInit 加载门店 A 数据
    // 触发 EVENT_STORE_CHANGED
    // 验证 _allSkus / _allCategories / cart 已清空
  });

  it('切换门店后重新加载商品', () => {
    // 模拟切换门店
    // 验证 loadShopInit 被调用
  });
});
```

#### L2 集成测试
```javascript
// fengyu-staff/tests/e2e-cloudfn/order-create-store-switch.mjs
// 1. 员工登录（有多门店权限）
// 2. 调用 product.shopInit（门店 A）
// 3. 切换 currentStoreId 到门店 B
// 4. 再次调用 product.shopInit（门店 B）
// 5. 验证返回的商品列表不同
```

---

## 风险评估

### 修复前风险
- **P0 严重**：员工可能下单不属于当前市场的商品，导致：
  - 订单分配错误（门店 B 的订单关联门店 A 的商品）
  - 库存扣减错误（门店 B 扣减门店 A 的库存）
  - 提成计算错误（市场归属不匹配）
  - 数据报表错乱

- **P1 高**：跨门店顾客串用
  - 门店 B 员工看到门店 A 的最近顾客
  - 可能给非本店顾客开单（虽然云端有校验，但前端体验差）

### 修复后风险
- **低风险**：切换门店时强制清空购物车，可能让用户感到意外
  - **缓解措施**：Toast 明确提示「已切换门店，购物车已清空」
  - **业务合理性**：跨门店混单本身就是错误场景，清空是正确行为

- **低风险**：频繁切换门店会多次调用 `loadShopInit`
  - **缓解措施**：已有 `catalogLoading` 防抖，且正常业务场景下员工不会频繁切换

---

## 部署建议

### 优先级：P1 - 高优先级

**建议立即部署**，因为：
1. 涉及订单数据正确性（P0 风险）
2. 修复逻辑简单，无破坏性变更
3. 仅影响员工端开单页，不影响其他模块
4. 无需数据库迁移

### 部署步骤
1. 合并本次修改到 `dev` 分支
2. 在测试环境验证上述 4 个手动测试场景
3. 灰度发布到少量员工（1-2 个门店）
4. 观察 1-2 天无问题后全量发布
5. 发布后监控：
   - 云函数 `order.create` 的 `PERMISSION_DENIED` 错误（跨门店开单）
   - 云函数 `product.shopInit` 调用频率（防止频繁切换导致的性能问题）

### 回滚方案
如遇问题，回滚 3 个文件即可：
```bash
git checkout HEAD~1 -- fengyu-staff/miniprogram/pages/order-create/order-create.ts
git checkout HEAD~1 -- fengyu-staff/miniprogram/app.ts
```

---

## 后续优化建议

### 短期（本次迭代）
- ✅ 已完成：修复开单页门店切换缓存问题
- ✅ 已完成：清除最近顾客缓存
- 🔲 待验证：真机测试（2 个以上门店账号）

### 中期（下个迭代）
- 🔲 考虑：切换门店时弹出二次确认对话框
  ```
  标题：切换门店
  内容：切换后将清空购物车和已选顾客，确认切换到「XX门店」？
  按钮：[取消] [切换]
  ```
  - **优点**：防止误操作
  - **缺点**：增加操作步骤，可能影响体验

- 🔲 考虑：保存购物车到本地（按门店隔离）
  ```typescript
  // 切换门店时保存当前购物车
  wx.setStorageSync(`cart_${oldStoreId}`, this.data.cart);
  // 切换回来时恢复
  const savedCart = wx.getStorageSync(`cart_${newStoreId}`);
  ```
  - **优点**：切换回来时可恢复未完成的订单
  - **缺点**：复杂度增加，需考虑商品/价格变动

### 长期（架构优化）
- 🔲 考虑：将门店上下文从 `globalData` 提取为独立的 Store 模块（类似 Redux）
  - 统一管理门店切换的副作用
  - 自动通知所有订阅者（不依赖 event-bus 手动维护）

---

## 变更文件清单

| 文件 | 变更类型 | 行数变化 | 说明 |
|------|---------|---------|------|
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 修改 | +50 | 新增门店切换监听 + onStoreChanged 方法 |
| `fengyu-staff/miniprogram/app.ts` | 修改 | +8 | setCurrentStoreId 清除最近顾客 |

**总变更**：2 文件，约 60 行代码

---

## 相关文档

- 项目规范：`CLAUDE.md` § 跨端变更
- 事件总线：`fengyu-staff/miniprogram/utils/event-bus.ts`
- 门店切换逻辑：`fengyu-staff/miniprogram/pages/workbench/workbench.ts:130-138`
- 开单页重置逻辑：`order-create.ts:1260-1282`

---

## 审核清单

- [x] 代码已修改
- [x] 文档已编写
- [ ] 手动测试已通过（待部署后验证）
- [ ] 真机测试已通过（待部署后验证）
- [ ] 代码已提交到 `dev` 分支
- [ ] PR 已创建并等待 Review

---

**修复人员**：Claude (AI Assistant)  
**审核人员**：待指定  
**预计上线时间**：待定
