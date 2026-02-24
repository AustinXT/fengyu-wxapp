# 凤御双小程序 — 系统架构设计

> 基于 `backend_pr.md`、`client_pr.md`、`staff_pr.md`、`workfine_database.md` 生成

---

## 一、整体拓扑

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          微信生态                                                    │
│  ┌─────────────────────────┐                              ┌─────────────────────────┐               │
│  │   fengyu-client（C端）   │                              │   fengyu-staff（B端）    │               │
│  │   顾客小程序              │                              │   员工端小程序             │               │
│  │   appid: wx_client_xxx  │                              │   appid: wx_staff_xxx   │               │
│  └───────────┬─────────────┘                              └────────────┬────────────┘               │
│              │  wx.cloud.callFunction()                                │  wx.cloud.callFunction()   │
└──────────────┼─────────────────────────────────────────────────────────┼────────────────────────────┘
               │                                                         │
               ▼                                                         ▼
┌──────────────────────────────────────┐         ┌──────────────────────────────────────┐
│   CloudBase 环境 A（fengyu-client）   │         │   CloudBase 环境 B（fengyu-staff）    │
│                                      │         │                                      │
│  ┌──────────────────────────────┐    │         │  ┌──────────────────────────────┐    │
│  │       云函数层（Node.js）      │    │         │  │       云函数层（Node.js）      │    │
│  │  ┌──────────┐  ┌──────────┐  │    │         │  │  ┌──────────┐  ┌──────────┐  │    │
│  │  │clientApi │  │payNotify │  │    │         │  │  │ staffApi │  │wsGateway │  │    │
│  │  │(顾客接口) │  │(支付回调) │  │    │         │  │  │(员工接口) │  │(实时推送) │  │    │
│  │  └────┬─────┘  └────┬─────┘  │    │         │  │  └────┬─────┘  └────┬─────┘  │    │
│  └───────┼─────────────┼────────┘    │         │  └───────┼─────────────┼────────┘    │
│          │             │             │         │          │             │             │
│          ▼             ▼             │         │          ▼             ▼             │
│  ┌────────────────────────────────┐  │         │  ┌────────────────────────────────┐  │
│  │       数据访问层（云函数内部）    │  │         │  │       数据访问层（云函数内部）    │  │
│  │  ┌─────────────┐  ┌─────────┐  │  │         │  │  ┌─────────────┐  ┌─────────┐  │  │
│  │  │ PG 自托管   │  │WorkFine │  │  │         │  │  │ PG 自托管   │  │WorkFine │  │  │
│  │  │ 数据库      │  │SQL Svr  │  │  │         │  │  │ 数据库      │  │SQL Svr  │  │  │
│  │  └─────────────┘  └─────────┘  │  │         │  │  └─────────────┘  └─────────┘  │  │
│  └────────────────────────────────┘  │         │  └────────────────────────────────┘  │
│                                      │         │                                      │
│  ┌──────────────────────────────┐    │         │  ┌──────────────────────────────┐    │
│  │  CloudBase 基础服务           │    │         │  │  CloudBase 基础服务           │    │
│  │  ・微信身份认证（OPENID）       │    │         │  │  ・微信身份认证（OPENID）       │    │
│  │  ・云存储（商品封面图等）        │    │         │  │  ・云存储（服务凭证等）          │    │
│  └──────────────────────────────┘    │         │  └──────────────────────────────┘    │
└──────────────────────────────────────┘         └──────────────────────────────────────┘

两环境共同访问的外部数据源：
  ┌──────────────────────────────────────────────────────────────┐
  │  PG 自托管数据库（读写；小程序专属数据）                          │
  │  ・orders / order_items    ・service_orders / service_items   │
  │  ・appointments            ・revenue_allocations              │
  │  ・product_spu / sku_map   ・client_wechat_users              │
  │  ・staff_wechat_users                                        │
  └──────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────┐
  │  Workfine SQL Server（只读；业务主数据）                        │
  │  111.229.31.128:1433  /  wkdb_20220804_86cd3292              │
  │  ・UDT_S_287 员工档案      ・UDT_M_219  门店列表               │
  │  ・UDT_M_1281 可售项目     ・UDT_M_1383 门店自定义项目          │
  │  ・UDT_M_341 院装产品      ・UDT_S_311  顾客档案（只读）        │
  └──────────────────────────────────────────────────────────────┘
```

---

## 二、项目目录结构

### 2.1 仓库根目录

```text
fengyu-wxapp/                     # mono-repo 根
├── fengyu-client/                # C端小程序（顾客）
│   ├── miniprogram/
│   └── cloudfunctions/
├── fengyu-staff/                 # B端小程序（员工）
│   ├── miniprogram/
│   └── cloudfunctions/
├── db/                           # PG 数据库 schema（Drizzle ORM）
│   ├── schema/
│   │   ├── enums.ts
│   │   ├── user.ts
│   │   ├── product.ts
│   │   ├── order.ts
│   │   ├── service.ts
│   │   └── appointment.ts
│   ├── drizzle.config.ts
│   └── package.json
├── notes/                        # 需求与设计文档
└── .42cog/                       # 认知模型与业务约束
```

### 2.2 客户端小程序（fengyu-client）

```text
fengyu-client/
├── miniprogram/
│   ├── app.ts                    # wx.cloud.init({ env: CLIENT_ENV_ID })
│   ├── app.json                  # tabBar: 首页/预约/订单/我的
│   ├── app.wxss
│   ├── pages/
│   │   ├── home/                 # 首页：门店选择 + 服务浏览
│   │   ├── product-list/         # 商品列表（三层：分类/SPU/SKU）
│   │   ├── product-detail/       # 商品详情 + SKU 选择
│   │   ├── order-confirm/        # 下单确认页（选美容师、支付方式）
│   │   ├── order-pay/            # 扫码收款页（员工开单后顾客扫码入口）
│   │   ├── order-list/           # 订单列表
│   │   ├── order-detail/         # 订单详情（含剩余次数、服务进度）
│   │   ├── appointment-list/     # 预约列表
│   │   ├── appointment-create/   # 发起预约
│   │   ├── service-detail/       # 服务单进度（只读）
│   │   └── profile/              # 个人中心（手机号绑定、门店切换）
│   ├── components/
│   │   ├── product-card/         # SPU 卡片（含生美/非生美标签）
│   │   ├── sku-selector/         # SKU 规格面板
│   │   ├── staff-picker/         # 美容师选择器
│   │   ├── order-status-tag/     # 订单状态标签
│   │   └── session-badge/        # 剩余次数徽章
│   ├── utils/
│   │   ├── cloud.ts              # callFunction 封装
│   │   ├── pay.ts                # wx.requestPayment 封装
│   │   └── auth.ts               # 登录/手机号绑定
│   └── models/                   # TypeScript 类型（与 db/schema 对齐）
├── cloudfunctions/
│   └── clientApi/                # 顾客端统一云函数入口（按 action 路由）
│       ├── index.js
│       ├── routes/
│       │   ├── auth.js           # 登录、手机号绑定
│       │   ├── store.js          # 门店列表
│       │   ├── product.js        # 商品列表/详情（PG + WorkFine）
│       │   ├── staff.js          # 美容师列表（WorkFine 只读）
│       │   ├── order.js          # 下单、查询、状态
│       │   ├── appointment.js    # 预约 CRUD
│       │   └── service.js        # 服务单查询
│       ├── middleware/
│       │   ├── auth.js           # OPENID → client_user_id
│       │   └── validate.js       # 参数校验
│       ├── db/
│       │   ├── pg.js             # PG 连接池（pg / postgres）
│       │   └── mssql.js          # WorkFine 连接（node-mssql）
│       └── package.json
└── project.config.json
```

### 2.3 员工端小程序（fengyu-staff）

```text
fengyu-staff/
├── miniprogram/
│   ├── app.ts                    # wx.cloud.init({ env: STAFF_ENV_ID })
│   ├── app.json                  # tabBar: 开单/顾客/服务单/预约
│   ├── app.wxss
│   ├── pages/
│   │   ├── order-create/         # 开单主流程（选顾客→选项目→分配→生成二维码）
│   │   ├── order-qrcode/         # 二维码展示页（待扫码/已扫码/已付款）
│   │   ├── order-list/           # 订单列表（含待确认收款）
│   │   ├── order-detail/         # 订单详情（含确认收款、营业额分配）
│   │   ├── revenue-allocation/   # 营业额分配界面
│   │   ├── customer-list/        # 顾客档案列表
│   │   ├── customer-detail/      # 顾客档案 + 日历视图
│   │   ├── service-list/         # 服务单列表（分配给我 / 本店全部）
│   │   ├── service-detail/       # 服务单详情（开始/完成服务）
│   │   ├── service-create/       # 创建服务单
│   │   ├── appointment-list/     # 预约管理列表
│   │   └── appointment-detail/   # 预约确认/到店记录
│   ├── components/
│   │   ├── calendar-view/        # 顾客日历视图（核心亮点）
│   │   ├── qrcode-display/       # 二维码组件（含轮询状态）
│   │   ├── allocation-form/      # 营业额分配表单
│   │   ├── role-guard/           # 角色权限拦截组件
│   │   └── session-counter/      # 疗程次数计数器
│   ├── utils/
│   │   ├── cloud.ts
│   │   ├── auth.ts               # 员工端登录 + 手机号绑定 + staff_wf_id 关联
│   │   ├── realtime.ts           # WebSocket + 轮询降级封装
│   │   └── role.ts               # 角色判断（店长 / 美容师）
│   └── models/
├── cloudfunctions/
│   └── staffApi/                 # 员工端统一云函数入口（按 action 路由）
│       ├── index.js
│       ├── routes/
│       │   ├── auth.js           # 员工登录、手机号绑定
│       │   ├── store.js          # 门店数据（WorkFine 只读）
│       │   ├── product.js        # 商品列表/详情（PG + WorkFine）
│       │   ├── staff.js          # 员工档案（WorkFine 只读）
│       │   ├── customer.js       # 顾客档案 + 日历数据
│       │   ├── order.js          # 开单、确认收款、关单
│       │   ├── allocation.js     # 营业额分配
│       │   ├── appointment.js    # 预约管理
│       │   └── service.js        # 服务单 CRUD + 完成核销
│       ├── middleware/
│       │   ├── auth.js           # OPENID → staff_user_id + staff_wf_id
│       │   ├── role.js           # 角色权限校验（店长/美容师）
│       │   └── validate.js
│       ├── db/
│       │   ├── pg.js
│       │   └── mssql.js
│       └── package.json
└── project.config.json
```

---

## 三、数据库分工

### 3.1 存储策略总览

| 数据域 | 存储位置 | 读写策略 | 说明 |
|--------|---------|---------|------|
| 员工档案（姓名/职位/门店/部门/是否可分配业绩） | Workfine SQL Server | 只读 | 人事主数据，由甲方在 Workfine 维护 |
| 门店信息 | Workfine SQL Server | 只读 | UDT_M_219，排除已停止营业门店 |
| 可售服务项目（全国/门店自定义）| Workfine SQL Server | 只读 | UDT_M_1281 + UDT_M_1383，实时读取价格/次数 |
| 院装产品 | Workfine SQL Server | 只读 | UDT_M_341，实时读取零售价 |
| 品项分类目录 | Workfine SQL Server | 只读 | UDT_M_229，21 种可用分类 |
| 顾客档案（历史数据） | Workfine SQL Server | 只读 | UDT_S_311，不建立 PG 实体 |
| 微信用户（顾客端） | PG 自托管 | 读写 | `client_wechat_users`，openid/手机号/绑定门店 |
| 微信用户（员工端） | PG 自托管 | 读写 | `staff_wechat_users`，openid/手机号/staff_wf_id |
| SPU 商品元数据 | PG 自托管 | 读写 | `product_spu`，名称/封面/描述/排序，运营维护 |
| SKU↔WorkFine 映射 | PG 自托管 | 读写 | `product_spu_sku_map`，is_active/product_type |
| 订单（主表+明细） | PG 自托管 | 读写 | `orders` + `order_items`，含剩余次数 |
| 营业额分配 | PG 自托管 | 读写 | `revenue_allocations` + `revenue_allocation_items` |
| 服务单（主表+明细） | PG 自托管 | 读写 | `service_orders` + `service_items` |
| 预约 | PG 自托管 | 读写 | `appointments` |

### 3.2 PG 数据库 ER 关系

```text
client_wechat_users ──1:N──> orders ──1:N──> order_items
                                                  │
                     staff_wechat_users             │ item_flow_no（核销锚点）
                            │                      ├──1:N──> appointments
                            │ staff_wf_id           └──1:N──> service_items
                            ▼                                      │
                       WorkFine                                    ▼
                      UDT_S_287                            service_orders
                     （员工主数据）

orders ──1:N──> revenue_allocations ──1:N──> revenue_allocation_items

product_spu ──1:N──> product_spu_sku_map ──N:1──> order_items.sku_id
                             │
                             └──N:1──> WorkFine（价格/次数，运行时读取）
```

---

## 四、云函数架构

### 4.1 函数最小化原则

采用**单函数多路由**模式，减少冷启动，降低运维复杂度：

| 云函数 | 所在项目 | CloudBase 环境 | 职责 |
|--------|---------|--------------|------|
| `clientApi` | fengyu-client | 环境 A（client） | 顾客端全部接口（按 `action` 字段路由） |
| `payNotify` | fengyu-client | 环境 A（client） | 微信支付异步回调（幂等处理） |
| `staffApi` | fengyu-staff | 环境 B（staff） | 员工端全部接口（按 `action` 字段路由） |
| `wsGateway` | fengyu-staff | 环境 B（staff） | WebSocket 实时推送 |

> 两端各自使用独立的 CloudBase 环境，云函数互不可见；payNotify 因微信支付回调 URL 固定，部署于 client 环境，支付完成后通过共享 PG 数据库状态触发员工端轮询或 WebSocket 推送。

### 4.2 接口路由约定

```javascript
// 调用示例
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.create',   // 路由：模块.方法
    payload: { ... }
  }
})
```

### 4.3 核心接口清单

#### clientApi（顾客端）

| action | 说明 | PG | WorkFine |
|--------|------|----|---------|
| `auth.login` | 微信登录，写入/更新 client_wechat_users | W | — |
| `auth.bindPhone` | 绑定手机号 + 补全历史订单 client_user_id | W | — |
| `store.list` | 门店列表 | — | R |
| `product.categories` | 品项分类列表（有效 SPU 派生） | R | — |
| `product.spuList` | SPU 列表（含 SKU is_active 状态） | R | R（价格） |
| `product.skuDetail` | SKU 详情（价格/次数从 WorkFine 实时读取） | R | R |
| `staff.list` | 美容师列表（按门店过滤在职） | — | R |
| `order.create` | 顾客自助下单 | W | — |
| `order.pay` | 发起微信支付（返回预支付参数） | R | — |
| `order.offlinePay` | 选择线下付款（进入待确认收款） | W | — |
| `order.list` | 订单列表（含体验单） | R | — |
| `order.detail` | 订单详情 + 明细 + 剩余次数 | R | — |
| `appointment.create` | 发起预约 | W | — |
| `appointment.list` | 预约列表 | R | — |
| `appointment.cancel` | 取消预约 | W | — |
| `service.detail` | 服务单状态查询（只读） | R | — |

#### staffApi（员工端）

| action | 说明 | PG | WorkFine |
|--------|------|----|---------|
| `auth.login` | 员工端登录，写入/更新 staff_wechat_users | W | — |
| `auth.bindPhone` | 绑定手机号 + 匹配 staff_wf_id | W | R |
| `store.list` | 门店列表 | — | R |
| `staff.list` | 本店员工列表 | — | R |
| `staff.departments` | 部门下可分配业绩员工 | — | R |
| `customer.search` | 按手机号查询顾客（WorkFine 档案 + client_wechat_users） | R | R |
| `customer.calendar` | 顾客日历数据（已支付订单按日汇总） | R | — |
| `product.categories` | 品项分类 + SPU 列表 | R | R |
| `product.skuDetail` | SKU 价格/次数实时读取 | R | R |
| `order.create` | 员工开单（店长权限）| W | R（价格快照）|
| `order.qrcode` | 获取/刷新订单二维码 | R | — |
| `order.confirmOffline` | 确认线下收款（店长权限）| W | — |
| `order.close` | 关闭订单（店长权限）| W | — |
| `order.resetFailed` | 重置支付失败订单（店长权限）| W | — |
| `order.list` | 订单列表 | R | — |
| `order.detail` | 订单详情 + 分配记录 | R | — |
| `allocation.save` | 保存/更新营业额分配 | W | — |
| `allocation.delete` | 删除分配方案（扫码前窗口内）| W | — |
| `appointment.list` | 预约列表（本店/分配给我）| R | — |
| `appointment.confirm` | 确认预约 | W | — |
| `appointment.checkin` | 顾客到店签到（记录时间）| W | — |
| `service.create` | 创建服务单（可关联预约）| W | — |
| `service.start` | 开始服务（待服务→服务中）| W | — |
| `service.complete` | 完成服务（扣减次数，幂等）| W | — |
| `service.list` | 服务单列表 | R | — |

#### payNotify（支付回调）

| 处理逻辑 | 说明 |
|---------|------|
| 验证签名 | HMAC-SHA256 校验微信支付回调签名 |
| 幂等检查 | 仅处理第一次成功回调（检查 orders.status !== '已支付'）|
| 更新订单状态 | `待支付 → 已支付`，写入 paid_at |
| 单品到期日 | 单品 order_items 写入 expire_date = paid_at + 1 year |
| 院装产品完成 | 院装 order_items 对应的 orders 置为 `已支付`（支付即交付）|
| 自动分配业绩 | 若 preferred_staff_wf_id 不为 null，自动创建 revenue_allocations |
| 实时推送 | 通知员工端 WebSocket 客户端 |

---

## 五、实时通信方案

### 5.1 双模策略（主推送 + 降级轮询）

```text
订单进入「已支付」
     ↓
payNotify 云函数
     ├──（主）WebSocket 推送至员工端在线客户端
     │        员工端 realtime.ts 收到事件 → 更新日历视图
     └──（降级）若 WebSocket 未连接/推送失败
               员工端 30 秒定时轮询 customer.calendar
               → 日历最终一致性更新
```

### 5.2 验收指标

| 指标 | 要求 |
|------|------|
| WebSocket 正常 | 订单支付后日历标记 **≤ 5 秒** |
| WebSocket 断开降级 | 轮询兜底 **≤ 30 秒** |
| 幂等 | 同一订单日历仅计入一次 |

---

## 六、安全与权限

### 6.1 认证机制

```javascript
// 云函数内获取调用者身份（自动，无需显式登录）
const { OPENID } = cloud.getWXContext()
// OPENID 与 appid 绑定，两端 OPENID 相互独立
```

### 6.2 角色权限矩阵

| 操作 | 顾客（clientApi） | 店长（staffApi） | 美容师（staffApi） |
|------|-------------------|-----------------|-------------------|
| 自助下单 | ✓ | — | — |
| 发起预约 | ✓ | — | — |
| 查看自己订单/服务 | ✓ | ✓（本店）| ✓（分配给我）|
| 查看完整手机号 | 自己 | ✓ | ✗ |
| 员工开单 | — | ✓ | ✗ |
| 确认线下收款 | — | ✓ | ✗ |
| 关闭/重置订单 | — | ✓ | ✗ |
| 营业额分配 | — | ✓ | ✗ |
| 创建服务单 | — | ✓ | ✓（仅分配给自己）|
| 推进服务状态 | — | ✓ | ✓（分配给自己）|
| 确认预约 | — | ✓ | ✓（被预约美容师）|

### 6.3 角色判断逻辑

```javascript
// staffApi middleware/role.js
async function requireManager(ctx) {
  const { staff_wf_id } = ctx.staffUser  // 从 staff_wechat_users 获取
  // 查询 WorkFine UDT_S_287.UDF_S_1161 = '门店经理'
  const isManager = await queryWorkfineRole(staff_wf_id)
  if (!isManager) throw new Error('PERMISSION_DENIED')
}
```

### 6.4 数据隔离规则

- 员工端只能访问**本店**数据（`store_name` 与登录员工档案 `UDF_S_1163` 匹配）
- 美容师只能操作 `assigned_staff_wf_id = self.staff_wf_id` 的服务单
- 所有写操作在云函数中完成，前端不直接写 PG

---

## 七、关键业务流程

### 7.1 顾客自助下单

```text
顾客 → product.spuList（PG + WorkFine）
     → product.skuDetail（WorkFine 实时价格）
     → order.create（写 PG orders + order_items，状态：待支付）
     → [微信支付] order.pay → wx.requestPayment
                            → payNotify 回调 → 状态：已支付 → 推送员工端
     → [线下付款] order.offlinePay → 状态：待确认收款
                                  → 店长 order.confirmOffline → 状态：已支付 → 推送员工端
```

### 7.2 员工开单

```text
店长 → customer.search（手机号查 client_wechat_users + WorkFine）
     → product.spuList → product.skuDetail
     → order.create（orders 写库，状态：待支付，order_source='staff'）
     → allocation.save（营业额分配，扫码前可修改）
     → order.qrcode（生成含 order_no 的小程序码）
     → 顾客扫码 → clientApi order.pay / order.offlinePay
     → 支付完成 → 日历实时更新
```

### 7.3 服务核销

```text
员工 → appointment.confirm（预约确认）
     → appointment.checkin（顾客到店）
     → service.create（创建服务单，关联 appointment_id + item_flow_no）
     → service.start（待服务 → 服务中）
     → service.complete（服务中 → 已完成）
         └── 原子扣减：UPDATE order_items
                        SET remaining_sessions = remaining_sessions - n
                        WHERE item_flow_no = $1 AND remaining_sessions >= n
         └── rowCount = 0 → 返回"次数不足"错误
         └── remaining_sessions = 0 → 批量关闭该行所有 待确认/已确认 预约
         └── 所有疗程卡/单品行 remaining_sessions 全归零 → orders.status = '已完成'
```

---

## 八、并发与幂等保障

| 场景 | 保障机制 |
|------|---------|
| 重复下单 | PG 部分唯一索引：`UNIQUE (client_user_id) WHERE status='待支付'` |
| 重复支付回调 | payNotify 检查 orders.status 非已支付才处理，UPDATE 带条件 |
| 重复确认线下收款 | 同上，仅处理 `待确认收款` 状态 |
| 并发疗程扣减 | 原子 UPDATE + rowCount 检查，禁止 SELECT-then-UPDATE |
| 重复完成服务 | service.complete 按 service_order_no 幂等，重复调用不重复扣次 |

---

## 九、SDK 初始化

```typescript
// fengyu-client/miniprogram/app.ts
App({
  onLaunch() {
    wx.cloud.init({
      env: 'fengyu-client-env-id',  // CloudBase 环境 A（顾客端专属）
      traceUser: true
    })
  }
})

// fengyu-staff/miniprogram/app.ts
App({
  onLaunch() {
    wx.cloud.init({
      env: 'fengyu-staff-env-id',   // CloudBase 环境 B（员工端专属）
      traceUser: true
    })
  }
})
```

> 两端各自使用独立的 CloudBase 环境，env ID 通过 `envQuery` MCP 工具查询确认。

---

## 十、开发优先级（MVP）

| 优先级 | 模块 | 端 |
|--------|------|----|
| P0 | auth（登录+手机号绑定） | 双端 |
| P0 | staffApi / order.create + allocation | 员工端 |
| P0 | payNotify（微信支付+线下确认） | 后端 |
| P0 | clientApi / order.create + pay | 客户端 |
| P0 | customer.calendar（日历视图） | 员工端 |
| P1 | 服务单 CRUD + service.complete（核销） | 员工端 |
| P1 | appointment（预约管理） | 双端 |
| P2 | product.spuList + WorkFine 商品对接 | 双端 |
| P2 | 实时推送 WebSocket + 轮询降级 | 员工端 |
