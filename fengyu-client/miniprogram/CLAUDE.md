# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

顾客端小程序前端，原生微信小程序 + Vant Weapp + TypeScript。

## TypeScript 配置

- `project.config.json` 已配置 `"useCompilerPlugins": ["typescript"]`
- 微信开发者工具优先使用 `.js`，若存在同名 `.js` 会忽略 `.ts`（确保不残留 .js）
- `tsconfig.json`：strict 模式，target ES2017，CommonJS 模块

## Tab 页面

| Tab | 页面 | 说明 |
|-----|------|------|
| 首页 | pages/home/home | Banner 轮播、金刚区、商品分类浏览、搜索 |
| 预约 | pages/appointment/appointment | 预约列表，按状态 Tab 筛选，FAB 创建 |
| 凤御馆 | pages/cart/cart | 品牌宣传长图 |
| 我的 | pages/profile/profile | 个人中心、手机绑定、门店切换、快捷入口 |

## 分包

| 分包 | 页面 |
|------|------|
| pagesShop | shop（服务目录）, service-detail（SKU 选择）, shopping-cart, staff-detail（美容师详情） |
| pagesOrder | orders（订单列表）, checkout（下单结算）, order-detail, scan-pay, treatment-cards, service-records（服务记录） |
| pagesStore | store-select（门店选择）, store-detail |
| pagesAppointment | appointment-create（创建预约） |
| pagesProfile | profile-edit（个人资料编辑）, points（积分）, messages（消息中心）, prepaid-cards（充值卡） |
| pagesCoupon | my-coupons（我的优惠券） |

## API 调用模式

所有页面通过 `utils/cloud.ts` 导出的工具函数调用云函数，**禁止直接使用 `wx.cloud.callFunction`**：

```typescript
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';

// 普通 API 调用（自动错误处理 + sanitizeErrorMessage）
const data = await callClientApi<{ orders: Order[] }>('order.list', { status: '已支付' });

// CloudID 手机号绑定（封装 loading/hideLoading + localStorage 持久化）
const { phone, updatedOrdersCount } = await bindPhoneWithCloudID(cloudID);
```

`utils/cloud.ts` 导出：
- `callClientApi<T>(action, payload)` — 通用 API 调用，返回 `res.result.data`，失败自动 throw
- `bindPhoneWithCloudID(cloudID)` — CloudID 绑定手机号，含 loading/error/storage 全流程
- `sanitizeErrorMessage(msg, fallback)` — 过滤技术性错误（仅内部使用）

## 全局状态（app.globalData）

```typescript
{
  userInfo: WechatMiniprogram.UserInfo | null,
  userId: string,
  boundStoreName: string,
  boundStoreId: string,
  boundMarketName: string,
  statusBarHeight: number,    // 系统状态栏高度
  navBarContentHeight: number, // 导航栏内容高度
  navBarHeight: number,        // 总导航栏高度（状态栏 + 内容）
}
```

- 启动时 `initNavBarInfo()` 计算导航栏高度 → `restoreFromCache()` 从 localStorage 恢复 → `syncLoginState()` 调用 `auth.login` 同步
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
pagesShop/service-detail → cart.addToCart() → localStorage
pagesShop/shopping-cart → setStorage('checkoutItems') → navigateTo pagesOrder/checkout
checkout → callClientApi('order.create') → order.pay → wx.requestPayment
```

### 预约
```
appointment-create → callClientApi('order.appointableItems') → 选项目/日期/时段/美容师
onSubmit → callClientApi('appointment.create') → switchTab appointment
```
