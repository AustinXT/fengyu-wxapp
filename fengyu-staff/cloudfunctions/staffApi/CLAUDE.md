# staffApi 云函数

员工端统一 API 网关，所有请求通过 action 路由分发。

## 目录结构

```
staffApi/
├── index.js          # 入口，action 路由分发 + 全局错误处理
├── package.json      # 依赖：wx-server-sdk, pg, mssql
├── middleware/
│   ├── auth.js       # 员工认证中间件（OPENID → staff_wechat_users + WorkFine 角色查询）
│   └── validate.js   # 参数校验（requireFields, validateTypes）
├── db/
│   ├── pg.js         # PostgreSQL 连接池（懒初始化，max 5）
│   └── mssql.js      # WorkFine SQL Server 只读连接（预热）
└── routes/
    ├── auth.js       # login, bindPhone
    ├── store.js      # list
    ├── staff.js      # list, departments
    ├── customer.js   # search, calendar
    ├── product.js    # categories, spuList, skuDetail, promotionList
    ├── order.js      # create, qrcode, confirmOffline, close, resetFailed, list, detail
    ├── allocation.js # save, deleteAllocation
    ├── appointment.js # list, confirm, checkin
    └── service.js    # create, start, complete, list
```

## API 路由模式

```javascript
// 员工端小程序调用
wx.cloud.callFunction({
  name: 'staffApi',
  data: {
    action: 'order.create',   // 模块.方法
    payload: { /* 参数 */ }
  }
})
```

## 响应格式

```javascript
{ code: 0, message: "success", data: {} }     // 成功
{ code: -1, message: "错误信息", data: null }   // 通用错误
{ code: -400, message: "...", data: null }      // 参数错误
{ code: -401, message: "...", data: null }      // 未授权
{ code: -403, message: "...", data: null }      // 权限不足
```

错误前缀约定：`UNAUTHORIZED:`、`PHONE_REQUIRED:`、`INVALID_PARAMS:`、`PERMISSION_DENIED:`

## 认证（staff 端特有）

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件查询 `staff_wechat_users` 表，再从 WorkFine `UDT_S_287` 查询角色
- ctx.auth = `{ userId, openid, phone, staffWfId, role, storeName, marketName, department }`
- `role = 'manager'` 当 WorkFine 职位 = '门店经理'，否则 `role = 'beautician'`
- `requireManager()` 中间件：仅店长可执行的操作使用
- `requireStaffBound()` 中间件：需要绑定手机号且关联员工档案

## 数据库

### PostgreSQL（读写）

| 表 | 用途 |
|----|------|
| `staff_wechat_users` | 员工微信用户 |
| `client_wechat_users` | 顾客微信用户（用于手机号查询） |
| `orders` + `order_items` | 订单主表与明细 |
| `revenue_allocations` + `revenue_allocation_items` | 营业额分配 |
| `service_orders` + `service_items` | 服务单 |
| `appointments` | 预约记录 |
| `product_spu` + `product_spu_sku_map` | 商品数据 |

### WorkFine SQL Server（只读）

| 表 | 用途 |
|----|------|
| `UDT_M_219` | 门店列表 |
| `UDT_S_287` | 员工档案（角色、门店、部门） |
| `UDT_M_1281` | 全国可售项目 |
| `UDT_M_1383` | 门店自定义项目 |
| `UDT_M_341` | 院装产品 |
| `UDT_S_1459` | 促销方案主表 |
| `UDT_M_1460` | 促销方案明细 |
| `UDT_S_311` | 顾客档案（搜索用） |

## 角色权限

| 角色 | 权限 |
|------|------|
| 店长（manager） | 全部功能：开单、营业额分配、确认收款、关闭/重置订单、查看完整手机号、管理所有服务单 |
| 美容师（beautician） | 查看指定自己的预约/服务单、推进服务状态；不可开单；不可查看客户完整手机号 |

## 关键业务规则

1. **员工开单**：店长专用，顾客手机号必填，自动查询是否已注册客户端账号
2. **营业额分配锁定**：订单为"待支付"时可修改；变为"待确认收款"或之后立即锁定
3. **服务单完成**：原子扣减 `remaining_sessions`，防止并发超扣；幂等处理重复点击
4. **手机号脱敏**：美容师查询顾客时，手机号仅显示后 4 位
5. **日历入账口径**：仅 `已支付` 订单，按 `paid_at` 统计当日金额

## 常用命令

```bash
npm install                    # 安装依赖
# 部署使用 CloudBase MCP 工具，详见 cloudbase-deploy skill
```

## 依赖

- `wx-server-sdk` - 微信云开发 SDK
- `pg` ^8.11.3 - PostgreSQL 客户端
- `mssql` ^10.0.1 - SQL Server 客户端

## 环境变量

- `PG_CONNECTION_STRING` - PostgreSQL 连接串
- `MSSQL_CONNECTION_STRING` - SQL Server 连接串（可选，不设则用默认配置）
