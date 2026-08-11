# Admin / Staff 前端权限与接口权限一致性审计

- 审计日期：2026-08-10
- 审计基线：`main@d3dc3ecf67d3bf59c712182bc3ae6753144cf1f3`
- 实施分支：`fix/store-level-deposit-approval@6de42fac`
- 状态：已实施并通过回归验证（2026-08-11）

## 审计口径

1. Admin：权限矩阵授予的 action 必须有对应可达 UI；按钮、弹窗、跨页链接和直达 URL 必须与 Server Action 门禁一致。
2. Staff：店长能力必须同时满足门店模式、有效 manager role 和当前门店在 `managerStoreIds` 内；管理层模式只允许其专属只读 API。
3. 后端门禁仍是最终安全边界；本次补齐 UI 与矩阵约束，不以隐藏按钮代替服务端鉴权。

## 已确认策略

| 主题 | 决定 |
| --- | --- |
| Admin 物理删除 | 所有 `*:delete` 仅 admin 可授予；UI 同时要求 action 与 admin 身份。 |
| 拉卡拉配置 | `store:lakala_config` 仅 admin 可授予；移除 manager 的无效默认授权。 |
| 自定义矩阵 | 保存时拒绝未知 action、非 admin 的不可授予 action、缺少页面硬依赖的 action，并列出缺失项。 |
| 辅助筛选 | 缺少 `store:list` 时列表仍可打开，筛选项降级为空；不把辅助筛选视为硬依赖。 |
| Admin 未交付库存能力 | 收回 `inventory:update`、`inventory:create_doc`、`inventory:approve`、`inventory:price_view`，保留后端实现但不再授权或展示。 |
| Staff 库存写能力 | 从公开路由移除 `inventory.createDoc`、`confirmReceive`、`approveDoc`、`rejectDoc`、`uploadReceipt`；保留只读与兼容接口。 |

## Admin 发现与实施清单

### P0：默认角色可复现

| UI / 页面 | 接口 action | 缺口 | 整改 |
| --- | --- | --- | --- |
| 订单列表确认收款、关闭、失败重置 | `sale_order:update` | 只读角色仍看到写按钮 | 传入 `canUpdate` 并门控行内操作。 |
| 服务单列表、详情和新建页 | `service:create`、`service:update` | 只读角色可见新建、状态流转与取消 | 传入 create/update capability，直达页服务端拒绝。 |
| 营业额分配与详情 | `allocation:save` | finance 仅 list 仍可编辑、删除和保存 | 以 save capability 门控全部编辑入口。 |
| 顾客列表与详情 | `customer:create`、`customer:update` | finance 可新增、编辑；customer_mgr 可见后端仅 manager/admin 的合并 | 细分 create/update/merge capability。 |
| 员工列表、详情、标签 | `employee:create`、`employee:update` | list-only 角色可见新增、标签、编辑、离职 | 细分 create/update/tag capability。 |
| 员工角色和密码 | `permission:assign`、`permission:revoke`、`permission:assign_admin`、`admin:reset_password` | 无权仍见角色编辑、admin 选项与重置密码 | 分离 assign/revoke/assign-admin/reset capability。 |
| 消息删除 | `message:delete` | list/send 角色可见删除 | 门控删除。 |
| 商品、商城、分类、创建/详情 | `product:create`、`product:update` | list-only 用户可直达写表单 | 页面与组件均按 capability 门控。 |
| 门店 | `store:create`、`store:update` | list-only 用户可直达新建/编辑；manager 的拉卡拉授权无效 | 直达门禁，配置仅 admin。 |
| 组织架构 | `org:create`、`org:update` | list-only 用户仍见增改 | 组件 capability 门控。 |
| 优惠券 | `coupon:list/create/update` | list-only 无菜单；发券单人检索错误依赖 `customer:list` | 菜单使用 list；新增最小 `coupon:create` 顾客检索。 |
| 工作台 | 预约、开单、权限入口 | 固定入口跳转至无权页 | 按目标 action 显隐。 |
| 提货新建、商户编辑 | `pickup_record:create`、`merchant:update` | 直达 URL 可见可提交表单 | 服务端页面门禁。 |

### P1：自定义矩阵与跨模块问题

- 预约确认/签到、提成创建/更新、门店解绑审批、历史订单审核/编辑均缺少细粒度 UI 门控。
- 订单、服务、顾客、员工、库存、提货、日志等物理删除页面仅看角色，未同时检查 delete action。
- 疗程卡、卡详情、商户详情、库存 hub 的跨模块链接未检查目标页面权限。
- `getMarketStoreFilterOptions()` 被多个列表页无条件调用，导致缺少 `store:list` 的已授权角色 SSR 403。
- 员工列表、详情、创建表单的组织/门店/技能标签读取构成硬依赖，必须被矩阵校验和直达页 gate 覆盖。

### 已收回或明确保留

- 收回 Admin 未交付库存 write/approve/price actions；仍保留已交付的 `inventory:list`、`inventory:stock_list`、`inventory:create`、`inventory:delete`、`inventory:export`。
- 退款、系统设置、会员权益、权限矩阵、数据中心现有 UI 与 action 一致，保持不变。

## Staff 发现与实施清单

| 范围 | 缺口 | 整改 |
| --- | --- | --- |
| 店长判定 | `isManager()` 未检查当前门店是否属于 `managerStores` | 前端改为门店模式 + 当前门店命中；云函数提供同口径 helper。 |
| 云函数角色分支 | 多处裸 `roles.includes('manager')` 可绕过店长范围 | 统一替换为当前门店有效店长 helper。 |
| 管理层模式 | 可进入共用订单/服务详情并显示门店写 CTA | 前端传只读上下文；网关集中拒绝管理层门店 mutation。 |
| 管理层页面 | 仅检查“可进入管理层”，未检查当前已切到 management | 统一使用 `isManagementMode()`，未切换即回门店工作台。 |
| 顾客详情 | 普通员工可编辑备注；余额 403 伪装为零；顾客分配字段错误 | 仅有效店长展示/请求敏感操作，修正 `staffList[].staffWfId`。 |
| 提货 | `order.createPickup` 仅检查员工绑定；查询未完全锁当前门店 | 改为有效店长，查询按 `effectiveStoreId` 收口。 |
| 库存 | 未交付写/审批接口仍公开 | 从路由表移除五个 write action。 |

## 验收

- Admin 矩阵、默认角色、最小自定义矩阵、页面 capability 与直达 URL 均有回归测试。
- Staff 覆盖当前门店切换、管理层模式、manager 范围、敏感顾客操作、提货与已移除路由。
- 修改 Admin 后运行 TypeScript 检查；修改云函数后验证参数化 SQL、OPENID 和现有 route tests。

## 实施记录

- [x] Admin 权限契约与矩阵校验
  - 新增 `permission-contract`：保存时汇总拒绝未知 action、非 admin 的 admin-only/delete、未交付库存 action 与缺失 UI 硬依赖；读取历史矩阵时清洗不可运行的遗留授权。
  - `hasUiCapability` 与 `requireUiPageCapability` 同时校验 action 和页面硬依赖；直达写页统一 `notFound()`。
  - `getMarketStoreFilterOptions()` 在缺少 `store:list` 时降级为空选项；优惠券单人发券改用仅返回姓名和手机号的 `coupon:create` 顾客检索。
- [x] Admin 页面和组件 capability 整改
  - 订单、服务、预约、分配、顾客、员工、权限、消息、商品/商城/分类、门店、组织、优惠券、提货、商户、历史订单、工作台和库存 Hub 的写入口、删除入口与跨页链接均按目标 action 过滤。
  - 所有物理删除同时要求对应 `*:delete` capability 与 admin 身份；库存未交付能力不再出现在默认/运行时矩阵。
- [x] Staff 范围、路由和页面整改
  - 登录与绑手机返回并缓存 `managerStoreIds`；门店写权限统一为门店模式 + 有效 manager 绑定 + 当前 `effectiveStoreId` 命中。
  - 网关拒绝管理层模式下全部门店业务 mutation；共享详情保留只读。
  - 提货创建与查询按当前有效店长和当前门店收口；五个未交付库存写/审批路由已从公开 action 表移除。
- [x] 回归验证与代码自检
  - `cd fengyu-admin && npx tsc --noEmit`：通过。
  - `cd fengyu-admin && bun run test`：111 个测试文件、1917 个测试通过。
  - `cd fengyu-staff/cloudfunctions/staffApi && bun run test`：42 个测试文件、1501 个测试通过，60 个跳过。
  - `cd fengyu-staff/miniprogram && bun run test`：17 个测试文件、649 个测试通过。
  - 已复核本次 staffApi 变更：OPENID 认证仍经统一 auth 中间件，新增/调整 SQL 均为 `$n` 参数化查询；`git diff --check` 通过。
