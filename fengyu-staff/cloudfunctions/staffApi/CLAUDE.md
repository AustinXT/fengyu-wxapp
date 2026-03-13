# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

员工端统一 API 网关，所有请求通过 action 路由分发。

## 目录结构

```
staffApi/
├── index.js          # 入口，action 路由分发 + 全局错误处理
├── package.json      # 依赖：wx-server-sdk, pg, mssql
├── middleware/
│   ├── auth.js       # 认证中间件（OPENID → 员工信息）
│   └── validate.js   # 参数校验（requireFields, validateTypes）
├── db/
│   ├── pg.js         # PostgreSQL 连接池（懒初始化）
│   └── mssql.js      # SQL Server 连接（WorkFine，仅特定查询）
├── routes/
│   ├── auth.js       # login, bindPhone
│   ├── store.js      # list, unbindRequests, approveUnbind, rejectUnbind
│   ├── staff.js      # list, departments, todayCommission, monthlyCalendar, todoList, bindStore
│   ├── customer.js   # search, calendar, detail, paidOrders
│   ├── product.js    # shopInit, categories, skuDetail, spuList, spuDetail, promotionList, promotionPlans
│   ├── order.js      # create, qrcode, confirmOffline, close, resetFailed, list, detail
│   ├── allocation.js # save, delete, rates, pendingList, suggest
│   ├── appointment.js # list, confirm, checkin, detail
│   ├── coupon.js     # available
│   └── service.js    # create, start, complete, cancel, list, detail
└── utils/
```

## 认证

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件查询 `staff_wechat_users` 表获取员工信息
- 员工必须已绑定手机号（openid 关联）才能使用大部分接口
- 支持 `_testOpenid` 测试模式

## 关键业务流程

### 开单（order.create）
- 仅店长可操作
- 事务内：advisory lock → 生成日序号 → INSERT sale_orders + sale_items → COMMIT

### 营业额分配（allocation.save）
- 锁定规则：订单待支付时可修改分配
- 分配项关联到具体员工

### 护理服务（service）
- create → start → complete 生命周期
- complete 原子扣减次数 + 幂等校验
- 支持预约关联（appointment_id）

## 依赖

- `wx-server-sdk` — 微信云开发 SDK
- `pg` — PostgreSQL 客户端
- `mssql` — SQL Server 客户端（WorkFine 查询）
