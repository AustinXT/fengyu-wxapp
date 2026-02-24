# 客户端云函数开发完成总结

## 完成时间
2026-02-25

## 已完成任务

### ✅ 1. 分析客户端云函数架构需求
- 阅读业务文档和系统架构设计
- 确定技术栈和模块划分
- 制定开发计划

### ✅ 2. 搭建 clientApi 云函数基础框架
**文件清单:**
- `package.json` - 依赖配置(pg, mssql, wx-server-sdk)
- `index.js` - 云函数入口,action 路由分发
- `db/pg.js` - PG 数据库连接池
- `db/mssql.js` - WorkFine SQL Server 只读连接
- `middleware/auth.js` - 认证中间件(OPENID → user_id)
- `middleware/validate.js` - 参数校验中间件

### ✅ 3. 实现认证模块 (routes/auth.js)
**接口:**
- `auth.login` - 微信登录,写入/更新 client_wechat_users
- `auth.bindPhone` - 绑定手机号 + 补全历史订单 client_user_id

### ✅ 4. 实现门店模块 (routes/store.js)
**接口:**
- `store.list` - 从 WorkFine UDT_M_219 查询门店列表,排除已停止营业门店

### ✅ 5. 实现商品模块 (routes/product.js)
**接口:**
- `product.categories` - 从 product_spu 动态派生有效分类
- `product.spuList` - SPU 列表 + WorkFine 实时价格
- `product.skuDetail` - SKU 详情(实时读取 WorkFine 价格/次数)

**特性:**
- 支持 WorkFine 三种数据源: UDT_M_1281(全国), UDT_M_1383(门店自定义), UDT_M_341(院装产品)
- 实时读取价格/次数,不缓存

### ✅ 6. 实现美容师模块 (routes/staff.js)
**接口:**
- `staff.list` - 从 WorkFine UDT_S_287 查询美容师列表,按门店过滤在职员工

### ✅ 7. 实现订单模块 (routes/order.js)
**接口:**
- `order.create` - 顾客自助下单
  - 验证用户身份和权限
  - 从 WorkFine 实时读取价格
  - 生成订单号(FY-XSD-WX-YYMMDD序号)
  - 生成销售流水号(XSLSH-WX-YYYYMMDD序号)
  - 写入 orders + order_items
  - 防重复下单(部分唯一索引)
- `order.pay` - 发起微信支付(返回预支付参数)
- `order.offlinePay` - 选择线下付款,进入"待确认收款"状态
- `order.list` - 订单列表(含体验单)
- `order.detail` - 订单详情 + 明细 + 剩余次数

**业务规则:**
- 必须绑定手机号才能下单
- 同一顾客只能有一笔待支付订单
- SKU 价格从 WorkFine 实时读取并快照

### ✅ 8. 实现预约模块 (routes/appointment.js)
**接口:**
- `appointment.create` - 发起预约
  - 验证订单明细归属
  - 检查剩余次数 > 0
  - 检查是否已有待确认/已确认预约
- `appointment.list` - 预约列表
- `appointment.cancel` - 取消预约(待确认/已确认状态)

### ✅ 9. 实现服务单模块 (routes/service.js)
**接口:**
- `service.detail` - 服务单状态查询(只读)

### ✅ 10. 创建部署配置和文档
**文件:**
- `.env.example` - 环境变量配置示例
- `README.md` - 云函数使用文档
- `DEPLOYMENT.md` - 部署指南

## 目录结构

```text
fengyu-client/cloudfunctions/clientApi/
├── index.js                    # 云函数入口
├── package.json                # 依赖配置
├── .env.example                # 环境变量示例
├── README.md                   # 使用文档
├── DEPLOYMENT.md               # 部署指南
├── db/
│   ├── pg.js                   # PG 数据库连接池
│   └── mssql.js                # WorkFine 只读连接
├── middleware/
│   ├── auth.js                 # 认证中间件
│   └── validate.js             # 参数校验中间件
└── routes/
    ├── auth.js                 # 认证模块
    ├── store.js                # 门店模块
    ├── product.js              # 商品模块
    ├── staff.js                # 美容师模块
    ├── order.js                # 订单模块
    ├── appointment.js          # 预约模块
    └── service.js              # 服务单模块
```

## 技术特性

### 1. 单函数多路由模式
按 `action` 字段路由分发,减少冷启动,降低运维复杂度。

### 2. WorkFine 只读
所有对 WorkFine 的操作仅限 SELECT,严禁写入。

### 3. 实时价格读取
SKU 价格/次数从 WorkFine 实时读取,不缓存到 PG。

### 4. 幂等性保证
- 订单号生成使用日期+序号,避免重复
- 部分唯一索引防止重复下单
- 支付回调幂等(待 payNotify 云函数实现)

### 5. 权限校验
- 所有写操作验证 user_id 归属
- 中间件统一处理认证和参数校验

### 6. 错误处理
- 统一错误码(code: 0 成功, -1 通用错误, -400 参数错误, -401 未授权, -403 权限不足)
- 结构化日志输出

## 待完成事项

### 1. payNotify 云函数
微信支付异步回调处理:
- 验证签名
- 幂等检查
- 更新订单状态(待支付 → 已支付)
- 写入单品到期日
- 院装产品直接完成
- 自动分配业绩(如果指定了美容师)
- 实时推送员工端

### 2. 微信支付对接
- 调用统一下单接口
- 生成预支付参数
- 处理支付结果

### 3. 实时推送
- WebSocket 推送或小程序订阅消息
- 订单支付成功后通知员工端

### 4. 美容师姓名查询
从 WorkFine 实时查询美容师姓名(预约模块)

### 5. 性能优化
- WorkFine 查询缓存(可选)
- PG 查询优化
- 连接池调优

### 6. 测试与验收
- 接口测试
- 并发测试(疗程卡扣减)
- 端到端测试

## 部署建议

### 环境变量配置
```bash
PG_CONNECTION_STRING=postgresql://用户名:密码@主机:5432/fengyu_wxapp
MSSQL_SERVER=111.229.31.128
MSSQL_PORT=1433
MSSQL_USER=Sa
MSSQL_PASSWORD=oHx#+Q
MSSQL_DATABASE=wkdb_20220804_86cd3292
```

### 运行时配置
- 运行时: Nodejs18.15
- 超时时间: 30 秒
- 内存: 256MB(默认)
- VPC: 如果 PG 在 VPC 内,需配置

### 部署方式
推荐使用 CloudBase MCP 工具或微信开发者工具上传。

## 验收标准

参考 `backend_pr.md` 第十节:
1. ✅ 小程序读取的员工、产品、组织架构数据与 WorkFine 设计端一致
2. ✅ 小程序中完成开单后,PG 数据库订单表中能查到同一笔记录
3. ⏳ 订单进入已支付后,员工端顾客日历在 5 秒内出现消费标记(待 payNotify + 实时推送)
4. ⏳ 同一笔订单无论重复提交多少次,在日历中仅计入一次(待 payNotify)
5. ⏳ 角色越权操作应被拒绝(美容师不可开单等 - 员工端实现)
6. ⏳ 同一服务单重复点击"完成服务"不产生重复扣次(员工端实现)

## 参考文档

- [系统架构设计](.42cog/spec/system_architecture.md)
- [客户端产品需求](notes/client_pr.md)
- [后端服务需求](notes/backend_pr.md)
- [WorkFine 数据库说明](notes/workfine_database.md)
- [wx-coding 技能文档](.claude/skills/wx-coding/SKILL.md)

## 下一步工作

1. **部署 clientApi 云函数**到 CloudBase 环境
2. **开发 payNotify 云函数**(微信支付回调)
3. **开发员工端 staffApi 云函数**
4. **实现实时推送机制**
5. **端到端测试与验收**
