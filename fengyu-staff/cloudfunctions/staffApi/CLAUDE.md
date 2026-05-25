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
│   ├── staff.js      # list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail
│   ├── customer.js   # search, calendar, detail, paidOrders, stats, listByTag, giftHistory, refundHistory, updateNotes, assign, customerBalance, appointments, phoneChangeLogs
│   ├── product.js    # shopInit, categories, skuList, skuDetail, spuDetail, promotionList, promotionPlans
│   ├── order.js      # create, qrcode, confirmOffline, close, resetFailed, list, detail, createRefund, approveRefund, rejectRefund, createRepayment, createConversion, createPickup, availablePickupItems, pickupRecordsList
│   ├── allocation.js # save, deleteAllocation, getCommissionRates, pendingList(支持 allocationStatus), suggest
│   ├── serviceCommission.js # pendingList(已完成服务单), detail, save（服务提成手动分配，按 ratio 拆分）
│   ├── appointment.js # list, detail, confirm, checkin
│   ├── coupon.js     # available
│   ├── service.js    # create, start, complete, cancel, list, detail, counts
│   ├── card.js       # rechargeSkus, recharge（充值卡独立开单路由）
│   ├── inventory.js  # list, detail（只读；门店库存 4 类单据：procurement/sale/transfer/scrap）
│   └── mgmt-dashboard.js # scopeOptions, summary, storeRanking, staffRanking
└── utils/
```

## 错误前缀约定（9 项白名单，单源 `utils/error-codes.js`）

云函数全局 catch 用 `buildErrorResponse(err)` 把 throw 转成 `{code, message, errorType, data}`。
任何 throw 必须使用以下 9 项前缀之一，否则降级为 `{code:-1, errorType:null, message:'服务器内部错误'}`：

`UNAUTHORIZED(-401)` / `PHONE_REQUIRED(-403)` / `INVALID_PARAMS(-400)` / `PERMISSION_DENIED(-403)` /
`NOT_FOUND(-404)` / `INSUFFICIENT_BALANCE(-400)` / `CONFLICT(-409)` / `INVALID_STATE(-400)` /
`CLIENT_NOT_REGISTERED(-400)`

二级前缀语法：`<一级>: <子标签>: <消息>`，子标签 `[A-Z_]+` 不计入白名单但允许（如 `INVALID_STATE: STATE_TRANSITION_BLOCKED: ...`）。
跨端一致性由 `__tests__/routes/cross-end-error-codes-snapshot.test.js` 守护。

## 认证

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件查询 `staff_wechat_users` 表获取员工信息
- 员工必须已绑定手机号（openid 关联）才能使用大部分接口
- 支持 `_testOpenid` 测试模式（需环境变量 `ALLOW_TEST_OPENID=true` 门控）

### ctx.auth 结构

```js
{
  openid, phone, staffWfId,
  storeId,                 // 员工档案默认门店（staff_wechat_users.store_id）— 不直接参与业务 SQL
  roles,                   // string[] 去重角色名（兼容字段）
  roleBindings,            // [{role, scopeId, scopeType}] 原始绑定
  staffLevel,              // headquarters / market / store_manager / store_staff / null
  scopeStoreIds,           // 当前账号有权见的全部 store_id（全角色并集）
  managerStoreIds,         // 仅 manager 角色绑定展开的 store_id；店长写操作授权用
  loginLevel,              // 'store' | 'management' — 从请求 payload._loginLevel 读（中间件兜底）
  currentStoreId,          // 门店模式下当前选中的门店
  effectiveStoreId,        // **业务 SQL 必须使用此字段作为门店过滤值**；管理层模式 = null
  position, storeName, marketName, department, skills
}
```

### 权限 scope helper（`utils/scope.js`）

- `deriveStaffLevel(roleBindings)` — 归并规则：总部 > 市场 > 门店 manager > 门店其他 > null
- `expandScopeStoreIds(roleBindings, pg)` — 按 org_nodes.type 反查可见 store_id 列表
- `buildStoreScopeCondition(auth, column, $n)` — 业务查询 WHERE 构造（门店模式单值 / 管理层模式 ANY(array)）

### 守卫中间件

- `requireStaffBound()` — 必须已绑定手机号 + 关联员工档案
- `requireManager()` — 必须有 `role='manager'` 绑定（总部/市场/门店任一层级）；门店模式下还要求 `effectiveStoreId ∈ managerStoreIds`（即 manager 角色覆盖的门店），兼容无 roleBindings 的旧缓存
- `requireManagementLevel()` — 必须 staffLevel ∈ {headquarters, market} 且 loginLevel='management'

## 关键业务流程

### 开单（order.create）
- 仅店长可操作
- 事务内：advisory lock → 生成日序号 → INSERT sale_orders + sale_items → COMMIT

### 营业额分配（allocation.save）
- 锁定规则：订单待支付时可修改分配
- 分配项关联到具体员工

### 服务单（service）
- create → start → complete 生命周期
- complete 原子扣减次数 + 幂等校验
- 支持预约关联（appointment_id）

## 依赖

- `wx-server-sdk` — 微信云开发 SDK
- `pg` — PostgreSQL 客户端
- `mssql` — SQL Server 客户端（WorkFine 查询）
