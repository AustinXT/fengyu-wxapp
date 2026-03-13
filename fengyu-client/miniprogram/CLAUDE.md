# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

顾客端小程序前端，原生微信小程序 + Vant Weapp + TypeScript。

## TypeScript 规范（重要）

**仅允许 `.ts` 文件，禁止 `.js`。**

- `project.config.json` 已配置 `"useCompilerPlugins": ["typescript"]`
- 微信开发者工具优先使用 `.js`，若存在同名 `.js` 会忽略 `.ts`
- `tsconfig.json`：strict 模式，target ES2017，CommonJS 模块

## Tab 页面

| Tab | 页面 | 说明 |
|-----|------|------|
| 首页 | pages/home/home | 轮播、疗程卡、热门服务 |
| 预约 | pages/appointment/appointment | 预约列表，按状态 Tab 筛选 |
| 凤御馆 | pages/cart/cart | 购物车入口 |
| 我的 | pages/profile/profile | 个人中心、手机绑定、门店绑定 |

## 分包

| 分包 | 页面 |
|------|------|
| pagesShop | shop（服务目录）, service-detail（SKU 选择）, shopping-cart |
| pagesOrder | orders（订单列表）, checkout（下单结算）, order-detail, scan-pay, treatment-cards |
| pagesStore | store-select（门店选择）, store-detail |
| pagesAppointment | appointment-create（创建预约） |
| pagesCoupon | my-coupons（我的优惠券） |

## API 调用模式

各页面内定义 `callClientApi` 调用云函数：

```typescript
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}
```

手机号绑定使用 CloudID 安全解密：
```typescript
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'auth.bindPhone',
    payload: {},
    phoneData: wx.cloud.CloudID(cloudID)
  }
})
```

## 全局状态（app.globalData）

```typescript
{
  userInfo: WechatMiniprogram.UserInfo | null,
  userId: string,
  boundStoreName: string,
  boundStoreId: string
}
```

- 启动时 `restoreFromCache()` 从 localStorage 恢复
- 随后 `syncLoginState()` 调用 `auth.login` 同步服务端状态
- `setUserInfo()` / `setStore()` 更新并持久化

## 状态管理

无集中状态管理。使用：
- **app.globalData**：用户 ID、绑定门店
- **Page.data + setData()**：页面级 UI 状态
- **localStorage**：userId、boundStoreName、phone、cart、checkoutItems
- **页面参数**：`wx.navigateTo({ url: '...?orderNo=xxx' })`

## 购物车（utils/cart.ts）

基于 localStorage 的客户端购物车：

```typescript
getCart(): Cart                              // 读取
addToCart(item, quantity?): Cart             // 添加/增量
updateQuantity(skuId, quantity): Cart        // 更新（<=0 删除）
removeFromCart(skuId): Cart                  // 删除
clearCart(): void                            // 清空
getCartCount(): number                       // 总数量
getCartTotal(): number                       // 总价
```

## UI 主题

白红主题（中国红），通过 CSS 变量覆盖 Vant 默认主题：

| 用途 | 变量 | 色值 |
|------|------|------|
| 品牌主色 | `--color-primary` | `#C0322A` |
| 红色浅底 | `--color-primary-light` | `#FFF0EE` |
| 深红 | `--color-primary-dark` | `#9B1E14` |
| 主文字 | `--color-text-primary` | `#1A1A1A` |
| 标题文字 | `--color-text-title` | `#333333` |
| 副文字 | `--color-text-secondary` | `#666666` |
| 提示文字 | `--color-text-hint` | `#999999` |
| 页面背景 | `--color-bg-page` | `#FAFAFA` |
| 卡片背景 | `--color-bg-card` | `#FFFFFF` |
| 区块背景 | `--color-bg-section` | `#F5F5F5` |
| 边框 | `--color-border` | `#E8E8E8` |

状态色：`--color-status-pending`(橙) / `--color-status-confirm`(金棕) / `--color-status-paid`(绿) / `--color-status-done`(灰) / `--color-status-failed`(红) / `--color-status-serving`(蓝)

在 `app.wxss` 中统一设置 Vant 覆盖变量和全局复用样式（`.status-*`、`.staff-*`、`.price-group` 等）。

## Vant Weapp 组件

版本 `^1.11.7`，每个页面 `.json` 中按需注册：
```json
{
  "usingComponents": {
    "van-button": "@vant/weapp/button/index"
  }
}
```

## 关键数据流

### 加购 → 结算
```
pagesShop/shop → cart.addToCart() → localStorage
pages/cart → setStorage('checkoutItems') → navigateTo pagesOrder/checkout
checkout → callClientApi('order.create') → order.pay → wx.requestPayment
```

### 预约
```
appointment-create → callClientApi('order.appointableItems') → 选项目/日期/时段/美容师
onSubmit → callClientApi('appointment.create') → switchTab appointment
```
