# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

顾客端统一 API 网关，所有请求通过 action 路由分发。

## 目录结构

```
clientApi/
├── index.js          # 入口，action 路由分发 + 全局错误处理
├── package.json      # 依赖：wx-server-sdk, pg
├── middleware/
│   ├── auth.js       # 认证中间件（OPENID → 用户信息，5 分钟内存缓存）
│   └── validate.js   # 参数校验（requireFields, validateTypes）
├── db/
│   └── pg.js         # PostgreSQL 连接池（懒初始化，max 5）
└── routes/
    ├── auth.js       # login, bindPhone, bindStore, updateProfile, uploadAvatar, uploadStaffAvatar
    ├── store.js      # list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode
    ├── product.js    # categories, spuList, skuDetail, spuDetail, hotList, shopInit, experienceCardList
    ├── staff.js      # list, default, detail
    ├── order.js      # create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail, scanAdjust, confirmPrepaidFull, repay, queryLakalaStatus, confirmPayment
    ├── appointment.js # create, list, cancel
    ├── service.js    # detail, list, confirm, createReview
    ├── coupon.js     # list, available
    ├── points.js     # balance, history
    ├── message.js    # list, read, unreadCount
    ├── card.js       # list, history, balance, rechargeConfig, recharge
    └── config.js     # banners, fengyuguan, shareGift, consumeAgreement, serviceHotline, invalidateConfig
```

## 认证

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件将用户信息挂载到 `ctx.auth`（userId, phone, boundStoreId, boundStoreName, boundMarketName）
- 内存缓存：200 用户上限，5 分钟 TTL，超限淘汰最旧 100 个
- `requirePhone()` 中间件：需要手机号的接口使用
- 支持 `_testOpenid` 测试模式

## 数据库

使用 PostgreSQL（`pg` 库），所有业务数据均在 PG 中：

```javascript
await pg.query(sql, params)                    // 查询
await pg.transaction(async (client) => {...})  // 事务（支持 advisory lock）
```

运行时 100% PostgreSQL，零 MSSQL 依赖。主要涉及表：client_wechat_users、staff_wechat_users、products、product_skus、product_categories、sale_orders、sale_items、sale_payment_item_receipts、sale_payment_item_allocations、service_orders、service_items、appointments、stores、org_nodes、coupon_templates、user_coupons、store_unbind_requests。

## 关键业务流程

### 订单创建
1. requirePhone → 校验手机号
2. 查询 SKU 信息（PG）
3. 事务内：advisory lock → 生成日序号 → INSERT sale_orders + sale_items → COMMIT
4. 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`

### 支付
- `order.pay` 返回微信支付参数
- `order.offlinePay` 线下支付确认

### 门店解绑
- `store.requestUnbind` 提交解绑申请 → 员工端审批

## 性能优化

- **路由懒加载**：冷启动只加载需要的模块
- **连接池**：PG max 5，懒初始化
- **用户缓存**：auth 中间件 5 分钟内存缓存
- **批量查询**：SKU 价格按分组批量查，避免 N+1
- **并行查询**：`Promise.all()` 处理无依赖查询
- **Advisory Lock**：防止并发序号冲突

## 依赖

- `wx-server-sdk` — 微信云开发 SDK
- `pg` ^8.11.3 — PostgreSQL 客户端
