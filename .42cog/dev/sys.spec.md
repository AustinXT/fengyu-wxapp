# 凤御双小程序 — 系统架构规格书

> 仅记录代码中无法推断的架构决策和约束机制。目录结构、API 列表、DB schema 请直接读取代码。

## 1. 架构拓扑

```text
┌── 微信生态 ─────────────────────────────────────────────┐
│  fengyu-client（C端）           fengyu-staff（B端）       │
│  wx811eb4ded3dfba3f            wxe3f5d9ee6a94d22d       │
└──────┬─────────────────────────────────┬────────────────┘
       │ wx.cloud.callFunction           │ wx.cloud.callFunction
       ▼                                 ▼
┌─ CloudBase 环境 A ──┐    ┌─ CloudBase 环境 B ──┐
│ clientApi, payNotify │    │ staffApi             │
└──────┬───────────────┘    └──────┬───────────────┘
       │                           │
       └───────────┬───────────────┘
                   ▼
         PostgreSQL（自托管，共享）
```

**关键隔离**：
- 两端使用独立 CloudBase 环境，云函数互不可见
- 两端 OPENID 相互独立（不同 appid）
- 唯一共享资源：PG 数据库

## 2. 架构决策

| 决策 | 理由 |
|------|------|
| 单函数多路由（action gateway） | 减少冷启动次数，CloudBase 免费额度按函数数计费 |
| 云函数用原生 SQL，不用 Drizzle | CloudBase 运行时不支持 TS，Drizzle 增加包体积和冷启动时间 |
| DB schema 用 Drizzle 管理 | 类型安全的 migration，与云函数运行时解耦 |
| 商品表 PG 原生管理（不再同步） | WorkFine 商品结构不稳定，一次性导入后由运营手动维护 |
| employees 合并到 staff_wechat_users | 减少 JOIN，sync 以 employee_id 为冲突键 UPSERT，openid 可为 null |
| customers 合并到 client_wechat_users | 减少 JOIN，sync 以 phone 为匹配键 UPSERT，openid 可为 null |
| payNotify 独立云函数 | 微信支付回调 URL 固定，不可用 action 路由 |

## 3. 集成边界

| 外部系统 | 角色 | 访问方式 | 说明 |
|---------|------|---------|------|
| WorkFine SQL Server | 同步数据源 | `db/scripts/sync-workfine.js` 定期同步 | 组织域（org_nodes/stores/staff）单向同步到 PG |
| 微信支付 | 运行时依赖 | payNotify 云函数接收回调 | 签名验证 + 幂等处理 |
| CloudBase 云存储 | 运行时依赖 | 云函数 SDK | 商品封面图、服务凭证等静态资源 |
| 微信身份认证 | 运行时依赖 | `cloud.getWXContext()` | 零代码获取 OPENID，无需自建认证 |

**已废弃**：云函数运行时不再直接访问 WorkFine SQL Server。所有原 MSSQL 查询已迁移为 PG 查询。

## 4. 约束保障机制

| real.md 约束 | 技术实现 |
|-------------|---------|
| 次数防超卖 | `UPDATE order_items SET remaining_sessions = remaining_sessions - $n WHERE ... AND remaining_sessions >= $n`，rowCount=0 即次数不足 |
| 价格快照不可变 | order_items 创建时写入 snapshot_price/snapshot_sessions，后续不可 UPDATE |
| 支付幂等 | `UPDATE orders SET status='已支付' WHERE order_no=$1 AND status='待支付'`，rowCount=0 即跳过；service.complete 按 service_order_no 幂等 |
| 状态单向推进 | 所有状态变更 `WHERE status = $current_status`，不匹配则拒绝；唯一例外：resetFailed |
| 后端统一鉴权 | middleware/auth.js 从 OPENID 查 user_id，middleware/role.js 校验角色；前端传参不可信 |
| 组织域数据隔离 | 所有查询 WHERE 加 store_id 过滤；美容师额外限定 assigned_employee_id = self |
| 待支付订单唯一 | PG 部分唯一索引 `UNIQUE (client_user_id) WHERE status='待支付'` + 应用层 pre-check |

## 5. 跨模块业务流

### 员工开单 → 顾客支付（跨双端）

```text
staffApi:order.create → PG 写入订单(待支付)
  → staffApi:order.qrcode → 生成小程序码(含 order_no)
  → 顾客扫码 → clientApi:order.pay → 微信支付
  → payNotify → 更新订单(已支付) + 写入 paid_at + 自动业绩分配
```

### 服务核销（跨预约→服务→订单）

```text
appointment.confirm → appointment.checkin(记录到店时间)
  → service.create(关联 appointment_id + item_flow_no)
  → service.start → service.complete
  → 原子扣减 remaining_sessions
  → 若归零：关闭关联预约 + 检查订单是否全部完成
```

## 6. 权限模型

### 角色×操作矩阵

| 操作 | 顾客 | 店长 | 美容师 |
|------|------|------|--------|
| 自助下单/预约 | ✓ | — | — |
| 查看自己订单 | ✓ | — | — |
| 员工开单 | — | ✓ | ✗ |
| 确认收款/关单/重置 | — | ✓ | ✗ |
| 营业额分配 | — | ✓ | ✗ |
| 查看本店订单 | — | ✓ | ✗ |
| 创建服务单 | — | ✓ | ✓（仅己） |
| 推进服务状态 | — | ✓ | ✓（仅己） |
| 确认预约 | — | ✓ | ✓（被预约者） |
| 查看完整手机号 | 自己 | ✓ | ✗（脱敏） |

### 数据隔离

- **顾客端**：所有查询 WHERE client_user_id = 当前用户
- **员工端-店长**：所有查询 WHERE store_id = 当前门店
- **员工端-美容师**：在店长范围基础上再限定 assigned_employee_id = self
- **角色判定**：staff_wechat_users.role 字段（manager/beautician）
