# 顾客端小程序（miniprogram）

凤御双美容院顾客端前端，原生微信小程序 + Vant Weapp + TypeScript。

## 目录结构

```
miniprogram/
├── app.ts / app.json / app.wxss   # 应用入口、路由配置、全局样式
├── pages/                          # 14 个页面
│   ├── home/                       # 首页：轮播、疗程卡、热门服务
│   ├── shop/                       # 服务目录：分类侧边栏 + 商品网格
│   ├── appointment/                # 预约列表：按状态 Tab 筛选
│   ├── appointment-create/         # 创建预约：日历、时段、美容师选择
│   ├── orders/                     # 订单列表：按状态 Tab 筛选
│   ├── order-detail/               # 订单详情：状态、明细、操作按钮
│   ├── cart/                       # 购物车：多选、数量调整、结算
│   ├── checkout/                   # 下单：支付方式、手机绑定、美容师选择
│   ├── service-detail/             # 服务详情：SKU 选择、数量、加入购物车
│   ├── profile/                    # 个人中心：手机号、绑定门店、快捷入口
│   ├── store-select/               # 门店选择：按区域分组、搜索
│   ├── store-detail/               # 门店详情：信息展示、绑定/切换
│   ├── treatment-cards/            # 疗程卡列表
│   └── scan-pay/                   # 扫码支付
├── utils/
│   └── cart.ts                     # 购物车工具（localStorage 持久化）
├── typings/
│   └── index.d.ts                  # 全局 TS 类型（IAppOption）
├── images/                         # logo + Tab 图标
└── miniprogram_npm/                # Vant Weapp 组件
```

## TypeScript 规范（重要）

**仅允许 `.ts` 文件，禁止 `.js`。**

- `project.config.json` 已配置 `"useCompilerPlugins": ["typescript"]`
- 微信开发者工具优先使用 `.js`，若存在同名 `.js` 会忽略 `.ts`
- 所有页面逻辑必须写在 `.ts` 中
- `tsconfig.json`：strict 模式，target ES2017，CommonJS 模块

## Tab 页面

| Tab | 页面 | 图标 |
|-----|------|------|
| 首页 | pages/home/home | home |
| 服务 | pages/shop/shop | shop |
| 预约 | pages/appointment/appointment | calendar |
| 我的 | pages/profile/profile | user |

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

黑金奢华风格，通过 CSS 变量覆盖 Vant 默认主题：

| 用途 | 颜色 |
|------|------|
| 主色（金） | `#D4A76A` |
| 品牌黑 | `#000000` |
| 正文 | `#1A1A1A` |
| 背景 | `#FAFAFA` |

在 `app.wxss` 中统一设置 `--button-primary-background-color`、`--tab-active-color` 等变量。

## Vant Weapp 组件

版本 `^1.11.7`，常用组件：

- 布局：`van-cell`、`van-cell-group`、`van-popup`
- 表单：`van-field`、`van-radio`、`van-checkbox`、`van-stepper`、`van-picker`
- 反馈：`van-toast`、`van-dialog`、`van-loading`、`van-empty`
- 导航：`van-tabs`、`van-tab`、`van-icon`
- 展示：`van-tag`、`van-skeleton`、`van-progress`、`van-calendar`
- 操作：`van-button`、`van-submit-bar`、`van-swipe-cell`、`van-search`

每个页面 `.json` 中按需注册：
```json
{
  "usingComponents": {
    "van-button": "@vant/weapp/button/index"
  }
}
```

## 导航模式

```typescript
wx.navigateTo({ url: '...' })   // 压栈（可返回）
wx.switchTab({ url: '...' })    // 切换 Tab（替换栈）
wx.redirectTo({ url: '...' })   // 替换当前页（支付后跳转）
wx.navigateBack()               // 返回上一页
```

## 关键数据流

### 加购 → 结算
```
shop → cart.addToCart() → localStorage
cart → setStorage('checkoutItems') → navigateTo checkout
checkout → callClientApi('order.create') → order.pay → wx.requestPayment
```

### 预约
```
appointment-create → callClientApi('order.appointableItems') → 选项目/日期/时段/美容师
onSubmit → callClientApi('appointment.create') → switchTab appointment
```
