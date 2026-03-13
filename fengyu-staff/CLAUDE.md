# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

员工端小程序（B端），包含前端和云函数。

## 基本信息

- **appid**: `wxe3f5d9ee6a94d22d`
- **CloudBase envId**: `cloud1-9g3ydpg512eecc99`
- **云函数**: staffApi（API 网关）

## 开发者工具

微信开发者工具打开 **`fengyu-staff/miniprogram/`**（注意：project.config.json 在 miniprogram/ 内，不是父目录）。没有 `miniprogramRoot` 设置，miniprogram/ 本身就是项目根。

Vant Weapp 需在 DevTools 中执行"构建 npm"（packNpmManually 模式）。

## 前端结构

### Tab 页面

| Tab | 页面 | 说明 |
|-----|------|------|
| 工作台 | pages/workbench/workbench | 今日提成、日历、待办、顾客搜索 |
| 开单 | pages/order-create/order-create | 4步开单流程（仅店长） |
| 护理 | pages/service/service | 护理单列表与管理 |
| 顾客 | pages/customer-list/customer-list | 顾客档案搜索与列表 |
| 我的 | pages/profile/profile | 员工信息、门店绑定 |

### 分包

| 分包 | 页面 |
|------|------|
| packageOrder | order-qrcode, order-list, order-detail, revenue-allocation, allocation-list |
| packageCustomer | customer-detail |
| packageService | service-list, service-detail, service-create, appointment, appointment-detail, product-detail, unbind-requests |

### 全局状态（app.globalData）

```typescript
{
  userId: string,
  staffWfId: string,      // WorkFine 员工编号
  staffName: string,
  position: string,       // 职位
  boundStoreName: string,
  boundStoreId: string,
  phone: string
}
```

启动时 `restoreFromCache()` 从 localStorage 恢复，随后 `syncLoginState()` 调用 `auth.login` 同步。支持 Mock 模式（`utils/dev-config` 中的 `MOCK_ENABLED`）。

### 角色权限

- `position` 含"经理"/"店长"：可开单、确认收款、营业额分配
- 其他（美容师等）：仅操作分配给自己的服务单
- 权限校验由云函数执行，前端仅做 UI 显隐

## staffApi 路由表

从 `cloudfunctions/staffApi/index.js` 路由映射：

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list, unbindRequests, approveUnbind, rejectUnbind |
| staff | list, departments, todayCommission, monthlyCalendar, todoList, bindStore |
| customer | search, calendar, detail, paidOrders |
| product | shopInit, categories, skuDetail, spuList, spuDetail, promotionList, promotionPlans |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail |
| allocation | save, delete, rates, pendingList, suggest |
| appointment | list, confirm, checkin, detail |
| coupon | available |
| service | create, start, complete, cancel, list, detail |

## 环境变量（云函数）

- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `CLIENT_SECRET` — 内部接口密钥
- `WXACODE_ENV_VERSION` — 小程序码环境版本
