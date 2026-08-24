# dev 环境积分功能专项测试报告（2026-08-13）

## 结论

dev 环境的积分查询、积分抵扣下单、0 元订单、FIFO 扣减、取消返还、并发防超扣、线下收款后赠分及重复操作幂等均通过。初检发现的整单退款阻断、未注册用户积分查询和分页参数校验问题，已于 2026-08-13 完成修复、部署和真链路复测。

修复后的 deployed `clientApi` + deployed `staffApi` 真链路完整通过“积分下单—支付—退款冲销”闭环：全额退款成功，赠送积分按目标态冲销，已支付订单使用的抵扣积分不返还，原订单优惠券恢复；测试夹具清理后积分缓存、批次、流水三账一致。

## 修复与复测结果

| 原问题 | 修复结果 | 部署态验证 |
|---|---:|---|
| 整单退款分享礼券 SQL 参数数量错误 | 已修复 | `ANY($1::text[])` 绑定单个券 ID 数组；整单退款审批成功 |
| 未注册 OPENID 可读取空积分账户 | 已修复 | `points.balance/history` 均先校验手机号；未注册用户返回 `PHONE_REQUIRED/-403` |
| `points.history` 缺少分页校验 | 已修复 | `page` 仅接受正整数，`pageSize` 仅接受 1–50 整数；非法值返回 `INVALID_PARAMS/-400` |
| dev 缺少显式抵扣上限配置 | 已修复 | `system_configs.points_deduction_max_rate=0.03` 已幂等补齐 |

部署与复测信息：

- `staffApi` 已部署到 `cloud1-9g3ydpg512eecc99`；`clientApi` 已部署到 `cloud1-3gpht4b01ff88838`。
- 部署包从 dev 云端现有函数代码下载后，仅打入本次积分修复，避免夹带工作区内尚未迁库的库存开发改动。
- 部署后只读核验 clientApi 的 `PG_CONNECTION_STRING` / `TMAP_KEY` / `TMAP_SECRET`，以及 staffApi 的 `PG_CONNECTION_STRING` / `CLIENT_SECRET` / `CLIENT_APPSECRET` / `WXACODE_ENV_VERSION`，均存在且指向 dev/develop。
- deployed 双端真链路连续两次通过；最终一轮同时覆盖未注册用户和非法分页守卫，清理与全局积分一致性校验通过。
- 微信开发者工具 9420 服务端口仍被本机 IDE 安全设置关闭；CLI 自动启用被 IDE 拒绝，L3 点击/截图验证仍需在 GUI 中手工开启服务端口后补跑。这是本机工具权限限制，不影响上述部署态 API 与真库闭环结论。

## 测试环境与范围

- 代码分支：`dev`
- 代码基线：`a6ba7f5e`（tag `v1.11.8`）
- clientApi dev 环境：`cloud1-3gpht4b01ff88838`
- clientApi / payNotify 状态：Active，2026-08-13 已更新
- dev PostgreSQL：`fengyu_wxapp`，测试前后只读审计 + 精确命名空间夹具
- 真链路方式：deployed clientApi + deployed staffApi + dev PostgreSQL
- 员工云函数 dev 环境初检时不在当前 TCB 会话可见范围；修复阶段已使用 staff 专属 API 凭据完成部署并直接调用 deployed staffApi 复测
- 微信开发者工具服务端口未开启，客户端/员工端 L3 视觉与点击自动化未能启动；页面逻辑单测和原生小程序静态护栏检查已完成

## dev 真库全链路结果

| 场景 | 结果 | 关键断言 |
|---|---:|---|
| 已部署 `points.balance` | 通过 | 余额、临期积分、折算比例 `0.01`、抵扣上限 `3%` 正确 |
| 已部署客户端积分下单 | 通过 | 原价 1000 元，券抵 100 元，3000 积分抵 30 元，应付 870 元 |
| 积分抵扣后 0 元订单 | 通过 | 原价 1000 元，券抵 970 元，3000 积分抵 30 元；创建即为已支付，实收 0，赠分 0 |
| FIFO 批次扣减 | 通过 | 先耗尽 2000 分临期批次，再从 3000 分批次扣 1000 分 |
| 线下确认收款赠分 | 通过 | 实收 870 元赠 8 分；重复确认被拒绝且不重复赠分 |
| 取消待支付订单返分 | 通过 | 扣分完整返还；重复取消不重复返还 |
| 缓存余额伪高 | 通过 | 批次真实余额不足时仍拒绝下单，事务无残留 |
| 并发积分下单 | 通过 | 余额只够一单时，2 个并发请求为 1 成功 / 1 失败，只有 1 笔扣分 |
| 非销售单积分守卫 | 通过 | 内部单使用积分被拒绝 |
| 员工端积分开单 | 通过 | 抵扣 1000 分，实收 990 元，确认后赠 9 分 |
| 整单退款审批与积分冲销 | **修复后通过** | 全额退款成功；赠送积分冲销、抵扣积分不返还、优惠券恢复 |
| 测试清理与账务一致性 | 通过 | `TE2LS%` 用户/流水/批次/订单均为 0；缓存、批次、流水三账无差异 |

## 自动化回归

综合去重后至少 691 项自动化断言通过，另有员工端既有套件中的 60 项按条件跳过：

- clientApi 积分、配置、下单相关：146 项通过
- 客户端结算页：16 项通过
- staffApi 积分、配置、订单、跨端快照：395 项通过，60 项跳过
- 员工端开单页：6 项通过
- 管理后台积分结算、配置、余额审计、会员升级、生日/感恩日、到期处理：67 项通过
- client L2 `points` 已部署云函数：6 项通过
- payNotify 支付成功赠分/退款差值结算：21 项通过
- 管理后台退款、退款工具、退款级联覆盖审计：34 项通过

修复阶段新增/重跑：

- clientApi 积分路由定向单测：20 项通过。
- staffApi 退款参数形状 + 跨端 SQL 守护：188 项通过。
- client L2 `points` 真 PG：8 个场景通过。
- deployed clientApi + deployed staffApi 积分真链路：连续 2 次通过，最终一次包含未注册与非法分页部署态断言。
- `git diff --check` 通过。
- 当前共享工作区全量单测另受并行库存/权限改动影响：client 560 项通过、1 项库存组成 fixture 失败；staff 1536 项通过、4 项库存组成/权限矩阵 fixture 失败。失败文件不在本次积分改动范围，且隔离部署包未包含这些未完成改动。

静态护栏检查覆盖客户端结算页、积分页和员工端开单页，未发现 `window`、`document`、`fetch`、直接改写 `this.data`、Web 事件名等原生小程序禁用模式。唯一的 `localStorage` 命中来自注释，实际实现使用微信存储 API。

## 缺陷与风险

### 1. 已修复：整单退款审批 SQL 参数数量错误

位置：`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js` 的分享礼券恢复查询。

SQL 只有一个参数：

```sql
WHERE coupon_id = ANY($1::text[])
```

调用却传入两个独立参数：

```js
[`sg-inviter-${saleOrderId}`, `sg-invitee-${saleOrderId}`]
```

实际错误：`bind message supplies 2 parameters, but prepared statement "" requires 1`，PG code `08P01`。现已将两个券 ID 作为 `$1` 对应的单个数组参数传入，并增加参数形状单测；deployed staffApi 整单退款复测通过。

### 2. 已修复：未注册 OPENID 可读取空积分账户

积分余额和流水路由均已增加手机号守卫。deployed `points.balance` 对不存在的 dev 测试 OPENID 返回 `PHONE_REQUIRED/-403`。

### 3. 已修复：`points.history` 缺少分页参数校验

- `page` 仅接受大于等于 1 的安全整数。
- `pageSize` 仅接受 1–50 的安全整数。
- 非法值在执行 SQL 前返回 `INVALID_PARAMS/-400`；`pageSize=-1` 与 `pageSize=1000` 的部署态断言均通过。

### 4. 已修复：抵扣上限依赖代码默认值

dev `system_configs` 现已显式包含 `points_to_yuan_rate=0.01` 与 `points_deduction_max_rate=0.03`，不再仅依赖代码默认值。

当前权益积分配置：生日各等级 0 分；升级仅黑钻 100 分；感恩日仅初钻 20 分。

## 数据审计

测试前 dev 基线：

- 顾客 2441；正积分余额顾客 295；缓存积分合计 17992
- 积分流水 476；积分批次 418；有效批次余额合计 17992
- 积分抵扣订单 0；积分结算失败审计 0
- 缓存与批次不一致 0；缓存与流水不一致 0；非法批次 0；已过期未处理批次 0
- 2026-08-09 起 79 笔符合赠分条件的原生订单，目标赠分与实际赠分差异为 0

测试完成后的独立核验：

- `TE2LS%` 测试用户 0、积分流水 0、积分批次 0、订单 0
- 全库缓存与批次不一致 0、缓存与流水不一致 0

## 新增测试资产

- `fengyu-staff/tests/e2e-cloudfn/dev-points-redemption.mjs`：显式手动运行的 deployed clientApi + deployed staffApi dev 积分抵扣真链路，不加入默认 smoke；无论成功失败都精确清理测试夹具
- client/staff L2、L3 清理夹具补充 `point_batches`、逐项收款明细及分配表的外键清理顺序，防止积分/收款测试残留

## 后续平台验证

业务代码、配置、部署和 deployed 双端真链路均已完成。仅剩本机平台层验证：在微信开发者工具开启“设置 → 安全设置 → 服务端口”，补跑客户端积分页、结算页和员工端开单页 L3 点击与截图验证。
