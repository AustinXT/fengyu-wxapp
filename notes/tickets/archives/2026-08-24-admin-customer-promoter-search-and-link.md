# Ticket: admin 顾客档案按手机号搜索员工推荐人并保存可靠关联

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-08-24 |
| 实施状态 | 待实施（已有 UI 雏形，需收紧数据契约） |
| 优先级 | **P1** |
| 端 | db + fengyu-admin + fengyu-staff 只读展示 |
| 来源 | meeting-20260821 顾客档案；2026-08-24 用户确认“展示 name，admin 按手机号搜索填报” |
| 关联字段 | `client_wechat_users.promoter_employee_name`，拟新增可靠员工关联字段 |

---

## 0 一句话目标

管理员编辑顾客档案时，通过员工手机号搜索并选择真实员工；系统保存员工关联并冻结/展示员工 `name`，不允许自由输入一个无法关联的推荐人姓名。

## 1 已确认产品规则

1. 填报入口在 admin 顾客详情编辑页。
2. 搜索主键为员工手机号，支持输入完整 11 位手机号；可保留姓名辅助搜索，但手机号必须可用。
3. 搜索结果显示员工 `name + 脱敏手机号 + 在职状态/所属门店`，避免同名误选。
4. 选择后页面和员工端顾客详情均展示员工 `name`。
5. 不允许自由文本提交；前端显示 name，不代表后端只存 name。
6. 已离职员工历史关联继续显示原姓名；是否允许新选择已离职员工默认为否。
7. 清空推荐员工需要显式操作，并写审计日志。

## 2 当前实现与问题

- admin 页面已有 `searchEmployees(q)` 异步下拉，提示“输入姓名或手机号搜索”。
- 用户选择结果后，前端只把 `emp.name` 写入 `promoterEmployeeName`。
- `updateCustomer` 接收 `promoterEmployeeName` 任意文本，没有要求 `employeeId`，服务端也不验证该姓名来自员工表。
- 数据库当前只有 `promoter_employee_name` 姓名快照，没有可靠的员工 FK；员工端只能显示文本，无法审计具体员工。
- 因此现状虽然“看起来能搜索”，仍可被构造请求写入自由文本，也无法处理同名员工。

## 3 数据模型

建议新增：

```text
client_wechat_users.promoter_employee_id text null
  FK → staff_wechat_users.employee_id
  ON DELETE SET NULL
```

保留 `promoter_employee_name` 作为历史/展示快照：

- 新选择员工时，同一事务写 `promoter_employee_id` 和当时的 `staff_wechat_users.name`。
- 员工后续改名是否同步历史快照：默认不同步；详情展示优先关联表当前 `name`，关联失效时回退快照。
- 存量只有姓名的数据不自动猜测关联；仅当姓名唯一且业务明确批准时另做 dry-run 回填。

## 4 admin 交互与 Server Action 契约

### 4.1 搜索

- 输入 3 位以上关键字后 300ms debounce；完整手机号可直接查询。
- `searchEmployees` 受 `employee:list` 权限和当前 session scope 限制，不能因推荐人搜索绕过组织权限。
- 最大返回 20 条，手机号只在有权用户界面按现有脱敏规则显示。
- 默认排除离职员工；无结果、加载和网络失败均有明确状态。

### 4.2 保存

前端提交：

```ts
promoterEmployeeId: string | null
```

服务端必须：

1. 按 ID 查询员工并验证可见范围与在职状态；
2. 不信任前端传入 name；
3. 从员工表读取 name，同时写 ID 和姓名快照；
4. 使用顾客现有 `updatedAt` 乐观锁；
5. 在 `operation_logs` 记录旧/新员工 ID 和展示姓名；
6. 非法、越权或离职员工返回规范化错误，不静默落空。

## 5 展示规则

- admin 和员工端统一展示：关联员工当前 `name` → 快照 `promoter_employee_name` → `—`。
- 列表导出仍输出展示姓名；如审计导出需要，可新增推荐员工编号列，但不输出完整手机号。
- 员工端本 ticket 只读展示，不增加编辑入口。

## 6 L0–L10 影响面

- **L1/L2** `db/schema/user.ts` + 新迁移：新增 FK/索引，保留姓名快照。
- **L4** `fengyu-admin/src/lib/types.ts`：新增 `promoterEmployeeId`。
- **L5/L9** `actions/customers.ts`、顾客详情编辑组件、搜索 action。
- **L7/L9** staffApi 顾客详情查询 LEFT JOIN 员工表并按回退规则返回 `promoterEmployeeName`。
- **L10** admin action/UI 测试、staff route 测试、迁移验证。

## 7 验收标准（DoD）

- [ ] 输入员工手机号能找到正确员工，结果显示 name 和脱敏手机号。
- [ ] 同名员工可通过手机号、门店和员工编号区分。
- [ ] 选择后请求只提交 employeeId，服务端解析并保存 name。
- [ ] 构造自由文本或不存在 employeeId 无法写入推荐人。
- [ ] 越权 scope、已离职员工不能被新绑定。
- [ ] admin 保存后刷新仍展示 name；员工端同步展示相同 name。
- [ ] 清空推荐人同时清空 ID/快照并产生审计记录。
- [ ] 存量只有姓名的顾客仍能回退展示，不因迁移丢失信息。
- [ ] 员工改名/删除场景符合 §3 回退规则。
- [ ] `npx tsc --noEmit`、admin Vitest、staff route 测试和迁移检查通过。

## 8 非目标

- 本 ticket 不实现“推荐顾客”编辑；现有 `inviter_user_id` 分享邀请关系保持只读。
- 不允许员工端修改推荐员工。
- 不用手机号作为数据库外键，也不把手机号存成推荐人快照。

