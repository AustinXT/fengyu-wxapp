# clientApi 云函数

客户端统一云函数入口,按 `action` 字段路由分发。

## 目录结构

```text
clientApi/
├── index.js                 # 云函数入口,路由分发
├── package.json             # 依赖声明
├── .env.example             # 环境变量配置示例
├── db/
│   ├── pg.js                # PG 数据库连接池
│   └── mssql.js             # WorkFine SQL Server 连接(只读)
├── middleware/
│   ├── auth.js              # 认证中间件(OPENID → user_id)
│   └── validate.js          # 参数校验中间件
└── routes/
    ├── auth.js              # 认证模块
    ├── store.js             # 门店模块
    ├── product.js           # 商品模块
    ├── staff.js             # 美容师模块
    ├── order.js             # 订单模块
    ├── appointment.js       # 预约模块
    └── service.js           # 服务单模块
```

## 接口列表

### 认证模块 (auth)

| action | 说明 | 权限 |
|--------|------|------|
| `auth.login` | 微信登录 | 无 |
| `auth.bindPhone` | 绑定手机号 | 已登录 |

### 门店模块 (store)

| action | 说明 | 权限 |
|--------|------|------|
| `store.list` | 门店列表 | 无 |

### 商品模块 (product)

| action | 说明 | 权限 |
|--------|------|------|
| `product.categories` | 品项分类列表 | 无 |
| `product.spuList` | SPU 列表 | 无 |
| `product.skuDetail` | SKU 详情 | 无 |

### 美容师模块 (staff)

| action | 说明 | 权限 |
|--------|------|------|
| `staff.list` | 美容师列表 | 无 |

### 订单模块 (order)

| action | 说明 | 权限 |
|--------|------|------|
| `order.create` | 顾客自助下单 | 已登录 + 绑定手机号 |
| `order.pay` | 发起微信支付 | 已登录 + 绑定手机号 |
| `order.offlinePay` | 选择线下付款 | 已登录 + 绑定手机号 |
| `order.list` | 订单列表 | 已登录 |
| `order.detail` | 订单详情 | 已登录 |

### 预约模块 (appointment)

| action | 说明 | 权限 |
|--------|------|------|
| `appointment.create` | 发起预约 | 已登录 + 绑定手机号 |
| `appointment.list` | 预约列表 | 已登录 |
| `appointment.cancel` | 取消预约 | 已登录 |

### 服务单模块 (service)

| action | 说明 | 权限 |
|--------|------|------|
| `service.detail` | 服务单详情 | 已登录 |

## 调用示例

```javascript
// 小程序端调用
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'store.list',
    payload: {}
  }
}).then(res => {
  console.log(res.result) // { code: 0, message: 'success', data: { stores: [...] } }
})
```

## 部署步骤

### 1. 配置环境变量

复制 `.env.example` 为 `.env` 并填写实际值:

```bash
cp .env.example .env
```

### 2. 安装依赖

```bash
cd fengyu-client/cloudfunctions/clientApi
npm install
```

### 3. 使用 CloudBase MCP 工具部署

```bash
# 创建云函数(首次部署)
# 注意: 需要在 CloudBase 控制台先创建环境,或使用 MCP 工具查询环境 ID

# 使用 createFunction 工具
# func.name: clientApi
# func.runtime: Nodejs18.15
# func.handler: index.main
# func.timeout: 30
# func.envVariables: 从 .env 文件读取
# force: true (覆盖已有同名函数)
```

### 4. 配置环境变量

部署后,在 CloudBase 控制台或使用 MCP 工具更新环境变量:

```javascript
// 使用 updateFunctionConfig 工具
{
  name: 'clientApi',
  envVariables: {
    PG_CONNECTION_STRING: 'postgresql://...',
    MSSQL_SERVER: '47.96.87.33',
    MSSQL_PORT: '1433',
    MSSQL_USER: 'SD',
    MSSQL_PASSWORD: 'Se4Qimoh',
    MSSQL_DATABASE: 'wkdb_20220804_86cd3292'
  }
}
```

## 数据库依赖

### PG 自托管数据库

需要提前创建以下表:

- `client_wechat_users` - 客户端微信用户表
- `product_spu` - SPU 商品表
- `product_spu_sku_map` - SKU 映射表
- `orders` - 订单主表
- `order_items` - 订单明细表
- `appointments` - 预约表
- `service_orders` - 服务单主表
- `service_items` - 服务单明细表

### WorkFine SQL Server

只读访问以下表:

- `UDT_M_219` - 门店列表
- `UDT_S_287` - 人事档案
- `UDT_M_1281` - 可售项目(全国)
- `UDT_M_1383` - 门店自定义项目
- `UDT_M_341` - 院装产品

## 注意事项

1. **WorkFine 只读**: 所有对 WorkFine 的操作仅限 SELECT,严禁写入
2. **疗程次数原子扣减**: 核销时使用原子 UPDATE,防止并发超扣
3. **幂等性**: 支付回调、服务完成等接口必须幂等
4. **权限校验**: 所有写操作必须验证 user_id 归属

## 错误码

| code | 说明 |
|------|------|
| 0 | 成功 |
| -1 | 通用错误 |
| -400 | 参数错误 |
| -401 | 未授权(未登录) |
| -403 | 权限不足(未绑定手机号等) |

## 开发调试

```bash
# 查看云函数日志
# 在 CloudBase 控制台 → 云函数 → clientApi → 日志

# 本地测试(需要配置 cloudbaserc.js)
tcb fn run --name clientApi
```

## 相关文档

- [系统架构设计](../../../.42cog/spec/system_architecture.md)
- [客户端产品需求](../../../notes/client_pr.md)
- [后端服务需求](../../../notes/backend_pr.md)
- [WorkFine 数据库说明](../../../notes/workfine_database.md)
