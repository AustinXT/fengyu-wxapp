# 优惠券显示真实面值修复

## 问题描述

员工端开单时，优惠券选择器显示的金额被订单应付金额限制，不是优惠券的真实面值。例如：
- 优惠券真实面值：3000 元
- 订单应付金额：400 元
- 显示的折扣：400 元（错误）

用户希望优惠券显示真实属性（面值），而不是被订单金额限制后的可用金额。

## 修改方案

在云函数返回优惠券列表时，同时返回两个字段：
- `discount`：针对当前订单实际可用的折扣金额（保持现有逻辑）
- `faceValue`：优惠券的真实面值（不受订单金额限制）

前端显示时：
- 主要金额显示：使用 `faceValue`（券面值）
- 当 `faceValue > discount` 时，额外显示"本单可用 ¥xxx"提示

## 修改文件清单

### 云函数（后端逻辑）

1. **staffApi/routes/coupon.js**
   - `available()` 方法返回结果添加 `faceValue: Number(coupon.discount_value)` 字段

2. **clientApi/routes/coupon.js**
   - `available()` 方法返回结果添加 `faceValue: Number(coupon.discount_value)` 字段

3. **fengyu-admin/src/actions/coupons.ts**
   - `getAvailableCoupons()` 返回结果添加 `faceValue: parseFloat(r.discountValue)` 字段

### 前端显示

4. **fengyu-staff/miniprogram/pages/order-create/order-create.ts**
   - 更新 `CouponInfo` 接口，添加 `faceValue?: number` 和 `couponType?: string` 字段

5. **fengyu-staff/miniprogram/pages/order-create/order-create.wxml**
   - 优惠券列表显示改为 `¥{{item.faceValue || item.discount}}`
   - 当 `faceValue > discount` 时显示"本单可用 ¥xxx"提示

6. **fengyu-staff/miniprogram/pages/order-create/order-create.wxss**
   - 添加 `.coupon-popup__item-available` 样式（橙色提示文字）

7. **fengyu-client/miniprogram/pagesOrder/checkout/checkout.wxml**
   - 优惠券列表显示改为 `¥{{price.fmt(item.faceValue || item.discount)}}`
   - 当 `faceValue > discount` 时显示"本单可用 ¥xxx"提示

8. **fengyu-client/miniprogram/pagesOrder/checkout/checkout.wxss**
   - 添加 `.coupon-popup__item-available` 样式（橙色提示文字）

9. **fengyu-admin/src/lib/types.ts**
   - 更新 `AvailableCoupon` 接口，添加 `faceValue: number` 字段

## 跨端一致性

按照项目规范，此修改涉及三端（staffApi、clientApi、admin），已全部同步修改：
- 三端云函数/action 均返回 `faceValue` 字段
- 前端显示逻辑一致：优先显示面值，面值大于可用金额时显示"本单可用"提示
- 样式保持一致：橙色提示文字 `#FA8C16`

## 视觉效果

修改后的优惠券列表显示：

```
┌─────────────────────────────────────┐
│  ¥3000        现金抵扣券            │
│  现金券       有效期至 2027-08-05    │
│               本单可用 ¥400.00      │  ← 新增提示
└─────────────────────────────────────┘
```

## 测试建议

1. 创建大面值优惠券（如 3000 元）
2. 创建小额订单（如 400 元）
3. 在员工端/客户端选择优惠券
4. 验证显示金额为 3000 元（面值），并显示"本单可用 ¥400"提示
5. 验证实际抵扣金额仍为 400 元（后端计算逻辑不变）

## 待部署

- [ ] staffApi 云函数
- [ ] clientApi 云函数  
- [ ] fengyu-admin 管理后台
- [ ] fengyu-staff 员工端小程序
- [ ] fengyu-client 客户端小程序
