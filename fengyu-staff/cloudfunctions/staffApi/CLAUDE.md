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
│   ├── staff.js      # list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail, dashboard
│   ├── customer.js   # search, calendar, detail, paidOrders, stats, listByTag, giftHistory, refundHistory, updateNotes, assign
│   ├── product.js    # shopInit, categories, skuList, skuDetail, spuDetail, promotionList, promotionPlans
│   ├── order.js      # create, qrcode, confirmOffline, close, resetFailed, list, detail, createRefund, approveRefund, rejectRefund, createRepayment, createConversion, createPickup
│   ├── allocation.js # save, deleteAllocation, getCommissionRates, pendingList, suggest
│   ├── appointment.js # list, detail, confirm, checkin
│   ├── coupon.js     # available
│   ├── service.js    # create, start, complete, cancel, list, detail, counts
│   └── mgmt-dashboard.js # scopeOptions, summary
└── utils/
```

## 认证

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件查询 `staff_wechat_users` 表获取员工信息
- 员工必须已绑定手机号（openid 关联）才能使用大部分接口
- 支持 `_testOpenid` 测试模式

### ctx.auth 结构

```js
{
  openid, phone, staffWfId,
  storeId,                 // 员工档案默认门店（staff_wechat_users.store_id）— 不直接参与业务 SQL
  roles,                   // string[] 去重角色名（兼容字段）
  roleBindings,            // [{role, scopeId, scopeType}] 原始绑定
  staffLevel,              // headquarters / market / store_manager / store_staff / null
  scopeStoreIds,           // 当前账号有权见的全部 store_id
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
- `requireManager()` — 必须有 `(role='manager', scopeType='门店')` 绑定（含多店店长），兼容无 scopeType 的旧数据
- `requireManagementLevel()` — 必须 staffLevel ∈ {headquarters, market} 且 loginLevel='management'

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
