# clientApi 云函数

顾客端统一 API 网关，所有请求通过 action 路由分发。

## 目录结构

```
clientApi/
├── index.js          # 入口，action 路由分发 + 全局错误处理
├── package.json      # 依赖：wx-server-sdk, pg, mssql
├── middleware/
│   ├── auth.js       # 认证中间件（OPENID → 用户信息，5 分钟内存缓存）
│   └── validate.js   # 参数校验（requireFields, validateTypes）
├── db/
│   ├── pg.js         # PostgreSQL 连接池（懒初始化，max 5）
│   └── mssql.js      # WorkFine SQL Server 只读连接（预热）
└── routes/
    ├── auth.js       # login, bindPhone, bindStore
    ├── store.js      # list, detail
    ├── product.js    # categories, spuList, skuDetail, spuDetail, hotList, shopInit
    ├── staff.js      # list, default
    ├── order.js      # create, pay, offlinePay, list, detail, appointableItems
    ├── appointment.js # create, list, cancel
    └── service.js    # detail
```

## API 路由模式

```javascript
// 小程序端调用
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.create',   // 模块.方法
    payload: { /* 参数 */ }
  }
})
```

路由懒加载：`require('./routes/' + module)` 按需加载。

## 响应格式

```javascript
{ code: 0, message: "success", data: {} }     // 成功
{ code: -1, message: "错误信息", data: null }   // 通用错误
{ code: -400, message: "...", data: null }      // 参数错误
{ code: -401, message: "...", data: null }      // 未授权
{ code: -403, message: "...", data: null }      // 权限不足
```

错误前缀约定：`UNAUTHORIZED:`、`PHONE_REQUIRED:`、`INVALID_PARAMS:`、`PERMISSION_DENIED:`。

## 认证

- 通过 `cloud.getWXContext()` 获取 OPENID
- auth 中间件将用户信息挂载到 `ctx.auth`（userId, phone, boundStoreName）
- 内存缓存：200 用户上限，5 分钟 TTL，超限淘汰最旧 100 个
- `requirePhone()` 中间件：需要手机号的接口使用
- 支持 `_testOpenid` 测试模式

## 数据库

### PostgreSQL（读写）

| 表 | 用途 |
|----|------|
| `client_wechat_users` | 顾客微信用户 |
| `product_spu` | 商品 SPU 元数据 |
| `product_spu_sku_map` | SKU 与 WorkFine 映射 |
| `orders` + `order_items` | 订单主表与明细 |
| `service_orders` + `service_items` | 服务单 |
| `appointments` | 预约记录 |

```javascript
await pg.query(sql, params)                    // 查询
await pg.transaction(async (client) => {...})  // 事务（支持 advisory lock）
```

### WorkFine SQL Server（只读）

| 表 | 用途 |
|----|------|
| `UDT_M_219` | 门店列表 |
| `UDT_S_287` | 员工档案 |
| `UDT_S_311` | 客户档案（主美容师） |
| `UDT_M_1281` | 可售项目（全国） |
| `UDT_M_1383` | 门店自定义项目 |
| `UDT_M_341` | 院装产品 |

## 关键业务流程

### 订单创建
1. requirePhone → 校验手机号
2. 查询 SKU 信息（PG）+ WorkFine 实时价格（并行）
3. 事务内：advisory lock → 生成日序号 → INSERT orders + order_items → COMMIT
4. 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`
5. 项目流水号：`XSLSH-WX-{YYYYMMDD}{4位序号}`

### 支付（当前为 Mock）
- `order.pay` 返回模拟微信支付参数
- TODO：接入真实微信支付 + payNotify 回调

### 服务核销
- 原子递减：`remaining_sessions = remaining_sessions - n WHERE remaining_sessions >= n`
- 幂等安全

## 性能优化

- **路由懒加载**：冷启动只加载需要的模块
- **连接池**：PG max 5，MSSQL max 5 min 1
- **用户缓存**：auth 中间件 5 分钟内存缓存
- **价格缓存**：WorkFine 价格 5 分钟模块级 Map 缓存
- **批量查询**：SKU 价格按 source 分组批量查，避免 N+1
- **并行查询**：`Promise.all()` 处理无依赖查询
- **Advisory Lock**：防止并发序号冲突

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
- `MSSQL_CONNECTION_STRING` - SQL Server 连接串
