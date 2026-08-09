# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

员工端小程序前端，原生微信小程序 + Vant Weapp + TypeScript。

## TypeScript 配置

- `project.config.json` 已配置 `"useCompilerPlugins": ["typescript"]`
- `tsconfig.json`：strict 模式，target ES2017，CommonJS 模块

## Tab 页面

| Tab | 页面 | 说明 |
|-----|------|------|
| 工作台 | pages/workbench/workbench | 今日提成、日历、待办、顾客搜索 |
| 开单 | pages/order-create/order-create | 4步开单流程（仅店长） |
| 服务 | pages/service/service | 服务单列表与管理 |
| 顾客 | pages/customer-list/customer-list | 顾客档案搜索与列表 |
| 我的 | pages/profile/profile | 员工信息、门店绑定 |

## 分包

| 分包 | 页面 |
|------|------|
| packageOrder | order-qrcode, order-list, order-detail, revenue-allocation, allocation-list, service-commission |
| packageCustomer | customer-detail |
| packageService | service-list, service-detail, service-create, appointment, appointment-detail, unbind-requests |

## 全局状态（app.globalData）

```typescript
{
  staffWfId, staffName, position, roles, skills, phone,
  boundStoreName, boundStoreId,            // 员工档案默认门店
  staffLevel,                              // 归并后的层级：headquarters/market/store_manager/store_staff
  roleBindings,                            // [{role, scopeId, scopeType}] 原始权限绑定
  availableLoginLevels,                    // ['store'] | ['management'] | ['store','management']
  scopedStores,                            // [{storeId, storeName}] 多门店切换下拉用
  loginLevel,                              // 当前登录模式：'store' | 'management'
  currentStoreId,                          // 门店模式下当前生效的 storeId
}
```

启动时 `restoreFromCache()` 从 localStorage 恢复（含 loginLevel / currentStoreId），随后 `syncLoginState()` 调用 `auth.login` 同步。支持 Mock 模式。

## 登录层级与视图切换

- 登录页根据 `availableLoginLevels` 动态显隐 "门店/管理层" radio（仅在 2 选 1 时显示）
- 门店模式：跳转至原生 tabBar（`workbench/order-create/service/customer-list/profile` 5 项）
- 管理层模式：`wx.reLaunch` 至 `/pages/mgmt-dashboard/mgmt-dashboard`，由 `components/mgmt-navbar` 提供底部导航
  - 管理层 4 页未放入原生 tabBar（小程序 `tabBar.list` 上限 5 项），所以使用独立导航组件
  - `availableLoginLevels` 由服务端根据运行时 `data_center:dashboard` 权限和非空 `scopeStoreIds` 下发，不以店长、市场或总部职级作为前端判断条件
- 本 ticket（2026-04-24）管理层 4 页仅搭骨架，业务功能由后续 ticket 逐个补齐（见 `pages/mgmt-*/`）

## workbench 门店切换

- 若 `scopedStores.length > 1`，顶部门店名可点击，弹 action-sheet 切换
- 切换仅更新 `globalData.currentStoreId` + 广播 `store-changed` 事件，不重登
- `callStaffApi` 自动在 payload 附加 `_loginLevel` / `_currentStoreId`

## 角色权限

- `utils/role.ts`：
  - `isManager()` — 门店店长（staffLevel = 'store_manager'）
  - `isBeautician()` — 门店非店长（store_staff）
  - `canAccessManagement()` — `availableLoginLevels` 包含 `management` 时为真
  - `getCurrentStoreId()` — 当前生效门店（业务组件使用）
- 权限校验由云函数执行，前端仅做 UI 显隐

## API 调用

通过 `utils/cloud.ts` 封装 CloudBase 调用，统一调用 staffApi 云函数。

## 分包补充

- `packageOrder` 还包含 `staff-performance`（绩效明细，仅从工作台首卡进入）
