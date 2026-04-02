# 凤御顾客端小程序 — 系统架构规格书

> 仅记录代码中无法推断的架构决策和约束机制。目录结构、API 列表、DB schema 请直接读取代码。
> **依赖文档**: `real.md` v3.1.0 | `cog.md` v4.0.0 | `client.pr.spec.md` v2.0.0 | `backend.pr.spec.md` v4.0.0

## 1. 架构拓扑

```text
┌─────────────────────────────────────────────┐
│     fengyu-client 顾客端小程序               │
│     appid: wx811eb4ded3dfba3f               │
│                                             │
│  ┌─ 主包 ─────────────────────────────────┐ │
│  │ home / appointment / cart / profile     │ │
│  └────────────────────────────────────────┘ │
│  ┌─ 分包 ─────────────────────────────────┐ │
│  │ pagesShop / pagesOrder / pagesStore /  │ │
│  │ pagesAppointment                       │ │
│  └────────────────────────────────────────┘ │
│           │                                 │
│     wx.cloud.callFunction                   │
│           │                                 │
└───────────┼─────────────────────────────────┘
            ▼
┌─ CloudBase 环境 A ──────────────────────────┐
│  cloud1-3gpht4b01ff88838                    │
│  ┌──────────┐  ┌──────────┐                 │
│  │ clientApi │  │payNotify │                 │
│  │ (网关)    │  │(支付回调) │                 │
│  └────┬─────┘  └────┬─────┘                 │
└───────┼──────────────┼──────────────────────┘
        │              │
        └──────┬───────┘
               ▼
      PostgreSQL（自托管，共享）
```

**关键隔离**：
- 顾客端与员工端使用**独立 CloudBase 环境**，云函数互不可见
- 两端 OPENID 相互独立（不同 appid），`client_wechat_users` 与 `staff_wechat_users` 完全分离
- 唯一共享资源：PG 数据库

## 2. 架构决策

| 决策 | 理由 |
|------|------|
| 单函数多路由（clientApi action 网关） | 减少冷启动次数，CloudBase 免费额度按函数数计费；payNotify 例外（微信回调 URL 固定） |
| 云函数用原生 SQL（`pg` 库） | CloudBase 运行时不支持 TS，引入 Drizzle 增加包体积和冷启动时间 |
| 购物车存 localStorage 而非服务端 | 顾客端无需跨设备同步；减少网络请求；切换门店时整体清空 |
| 分包策略按业务域划分 | pagesShop（商品）/ pagesOrder（订单）/ pagesStore（门店）/ pagesAppointment（预约），主包 < 2MB |
| 认证零登录页 | 微信静默登录 + CloudID 手机号解密；`PHONE_REQUIRED` 错误码触发绑定流；禁止自建登录表单 |
| 扫码支付复用已有订单 | 员工端开单时订单已入库（`待支付`），顾客扫码后无需重复创建，仅查询并支付 |
| 商品分页 + 模块级缓存 | SPU 列表按分类缓存（`categoryId` 为键），scroll-to-lower 500ms 防抖避免重复请求 |
| 福利活动绕过购物车 | 福利活动单品直接下单，不进购物车，确保单独成单（`sale_order_type='福利活动'`） |

## 3. 认证模型

```text
app.onLaunch()
  → localStorage 恢复 → auth.login（静默，OPENID 自动注入）
  → 新用户：自动创建 client_wechat_users（ID: FYGK-{YYYYMMDD}{序号}）
  → 需手机号时：API 返回 -403 PHONE_REQUIRED
    → 前端 getPhoneNumber（CloudID）→ auth.bindPhone
    → 触发历史订单补全（client_user_id IS NULL + phone 匹配）
    → 清除 auth 缓存 → 自动重试原请求
```

**顾客端认证无角色区分**，所有已认证用户权限等同。数据隔离通过 `WHERE client_user_id = 当前用户` 实现。

**手机号补全机制**：员工以手机号开单 → 顾客后续注册绑定手机号 → `sale_orders.client_user_id` 批量回填，历史订单自动可见。

## 4. 前端状态管理

| 状态类型 | 存储位置 | 说明 |
|---------|---------|------|
| 认证信息 | `app.globalData` + localStorage | `onLaunch` 先 restore 再 sync |
| 购物车 | localStorage（`utils/cart.ts`） | CartItem: `{ skuId, spuId, spuName, skuDisplayName, coverImage, price, quantity, bigCategory, productType, addedAt }` |
| 结算数据 | localStorage `checkoutItems` | 购物车结算时写入，结算页读取 |
| 商品缓存 | Page 级内存 | 按 categoryId 缓存 SPU 列表，切换门店时清空 |
| 门店绑定 | `app.globalData.boundStoreId` + localStorage | 首次选择后默认展示该门店商品 |

**无全局状态管理库**：小程序原生模式，页面间通过 URL 参数 + localStorage + `globalData` 通信。

## 5. 云函数中间件链

```text
clientApi 请求处理流程：

event { action, payload }
  → index.js: 解析 action → require(`./routes/${module}`)
  → middleware/auth.js: OPENID → 查 client_wechat_users → ctx.auth
    （auth.login / order.scanDetail 跳过认证）
  → middleware/validate.js: 参数校验
  → routes/[module].[method](payload, ctx)
  → 响应: { code: 0, message, data } 或 { code: -1/-400/-403, message }
```

**免认证接口**：`auth.login`（创建用户本身）、`order.scanDetail`（扫码查单，支持未注册用户）。

**错误码体系**：
- `0` — 成功
- `-1` — 通用错误
- `-400` — 参数错误（`INVALID_PARAMS:` 前缀）
- `-401` — 未认证（`UNAUTHORIZED:` 前缀）
- `-403` — 手机号未绑定（`PHONE_REQUIRED:` 前缀）

## 6. 约束保障机制

| real.md 约束 | 顾客端实现 |
|-------------|-----------|
| 次数防超卖 | 顾客端不直接扣次数；仅通过 `service.detail` 查看剩余次数 |
| 价格快照不可变 | `order.create` 时从 `product_skus.price` 快照到 `sale_items.unit_price`，前端显示的价格与下单时独立 |
| 支付幂等 | `order.pay` / `payNotify` 通过 `WHERE status='待支付'` 幂等；线下确认由员工端操作 |
| 状态单向推进 | 顾客端仅可：取消订单（待支付→已关闭）、取消预约（待确认/已确认→已取消）；其他状态变更由员工端或系统触发 |
| 待支付订单唯一 | `order.create` 时 PG 部分唯一索引 + 应用层 pre-check；前端防连点 + 按钮 loading 态 |
| 组织域数据隔离 | 所有查询 `WHERE client_user_id = ctx.auth.userId`，顾客只能看到自己的订单/预约/服务单 |

## 7. 跨模块业务流

### 7.1 自助下单支付

```text
product.shopInit(门店商品初始化)
  → product.categories / product.spuList / product.skuDetail
  → 加入购物车(localStorage) 或 直接下单
  → order.create(SKU 快照 + 可选美容师 + 可选券)
    → PG 写入 sale_orders(待支付) + sale_items
    → 返回 orderNo
  → order.pay(wechat/alipay/offline)
    → wechat: 调起微信支付 → payNotify 回调 → 更新已支付
    → offline: 更新待确认收款 → 等待店长确认
  → 已支付 + 指定美容师 → 自动创建 sale_allocations
```

### 7.2 扫码支付（跨双端）

```text
员工端 order.create → PG 订单(待支付)
  → 员工端 order.qrcode → 生成小程序码(含 orderNo 或 path)
  → 顾客微信扫码 → 顾客端解析:
    → path 型: navigateTo 对应页面
    → orderNo 型: 跳转 scan-pay 页面
  → order.scanDetail(免认证, 仅 sale_order_source='staff')
  → 选择支付方式 → order.pay → payNotify → 已支付
```

### 7.3 预约核销

```text
订单已支付 → order.appointableItems(remaining_sessions > 0, 非院装)
  → appointment.create(选项目/美容师/时段)
    → ID 格式: apt_{timestamp}_{random}
    → 时段: 09-11/11-13/13-15/15-17/17-19
  → 员工端 appointment.confirm → 员工端 service.create(关联 appointment_id)
  → 服务完成(员工端) → 原子扣减 remaining_sessions
  → 归零 → 自动关闭关联预约
```

### 7.4 门店解绑

```text
顾客发起 store.requestUnbind(reason)
  → status: 待处理
  → 员工端 store.approveUnbind / rejectUnbind
  → 已通过: 清除 client_wechat_users.bound_store_id
  → 顾客可查看状态 / 可取消(待处理 时)
```

## 8. 外部集成

| 外部系统 | 集成方式 | 触发点 |
|---------|---------|--------|
| 微信支付 | payNotify 云函数接收回调 | `order.pay` 调起支付后 |
| 微信身份 | `cloud.getWXContext()` 零代码注入 | 每次云函数调用 |
| CloudID 手机号 | `getPhoneNumber` → 云端解密 | `auth.bindPhone` |
| 腾讯地图 | `store.geocode` 逆地理编码 | 门店列表页定位推荐 |
| CloudBase 云存储 | 商品封面图/门店环境图 URL | 前端 image 组件直接引用 |

**环境变量**：
- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `TMAP_KEY` / `TMAP_SECRET` — 腾讯地图 API

## 9. 订单超时机制

**10 分钟超时**：`expire_at = created_at + 10min`，不存储字段，应用层 SQL 条件懒清理。

清理时机（三处）：
1. `order.create` — 创建前检查是否有超时待支付单
2. `order.list` — 列表查询排除超时单
3. `order.pay` — 支付前验证未超时

前端倒计时：待支付详情页 `MM:SS` 格式，1s 刷新，超时自动重载页面触发状态同步。

## 10. 优惠券集成

**下单流程**：
1. `coupon.available(storeId, skuIds)` — 查询可用券（匹配门店+商品+有效期+未使用）
2. 用户选券 → `order.create` 传入 `couponId`
3. 后端原子校验：`UPDATE user_coupons SET status='已使用' WHERE coupon_id=$1 AND status='未使用'`（rowCount=0 即券已使用）
4. 券抵扣金额写入 `sale_orders.coupon_discount`

**券与购物车独立**：券选择在结算页进行，不影响购物车状态。

## 11. 不包含（顾客端不实现）

| 能力 | 归属 |
|------|------|
| 开单/营业额分配/服务推进 | 员工端 |
| 权限管理 | 员工端/管理后台 |
| 数据看板/报表 | 管理后台 |
| 商品管理（CRUD） | 管理后台 |
| 券发放/模板管理 | 管理后台 |
| WorkFine 数据同步 | db/scripts 离线脚本 |
