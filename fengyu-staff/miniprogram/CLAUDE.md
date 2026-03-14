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
| 护理 | pages/service/service | 护理单列表与管理 |
| 顾客 | pages/customer-list/customer-list | 顾客档案搜索与列表 |
| 我的 | pages/profile/profile | 员工信息、门店绑定 |

## 分包

| 分包 | 页面 |
|------|------|
| packageOrder | order-qrcode, order-list, order-detail, revenue-allocation, allocation-list |
| packageCustomer | customer-detail |
| packageService | service-list, service-detail, service-create, appointment, appointment-detail, product-detail, unbind-requests |

## 全局状态（app.globalData）

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

## 角色权限

- `position` 含"经理"/"店长"：可开单、确认收款、营业额分配
- 其他（美容师等）：仅操作分配给自己的服务单
- 权限校验由云函数执行，前端仅做 UI 显隐
- 角色判断工具在 `utils/role.ts`

## API 调用

通过 `utils/cloud.ts` 封装 CloudBase 调用，统一调用 staffApi 云函数。

## 分包补充

- `packageOrder` 还包含 `dashboard`（数据看板）、`staff-performance`（绩效明细）
