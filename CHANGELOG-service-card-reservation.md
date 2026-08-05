# 服务期间疗程卡预扣锁定机制实施记录

**日期**: 2026-08-06  
**问题**: 服务单处于"服务中"或"待确认"状态时，疗程卡被转换单消耗，导致服务确认时报错"剩余次数不足"

## 根本原因

服务单状态流转与次数扣减时机错配导致的并发竞态条件：
- 服务单从"待服务"→"服务中"→"待客户确认"期间，疗程卡的 `remaining_sessions` 未被锁定
- 转换单创建时会原子置 `remaining_sessions=0`，与进行中的服务单冲突

## 解决方案

实施两阶段预扣机制：
1. **预扣阶段**：服务开始时（`service.start`），标记 `service_items.reserved_at`
2. **确认阶段**：服务确认时（`service.confirm`），清除预扣标记 + 正式扣减次数

## 实施的变更

### 1. 数据库 Schema (✅ 已完成)

**文件**: `db/migrations/0079_add_service_items_reserved_at.sql`
- 新增字段: `service_items.reserved_at timestamptz`
- 新增索引: `idx_service_items_sale_item_reserved` (WHERE reserved_at IS NOT NULL)
- 数据修复: 为现有"服务中"/"待客户确认"服务单补打预扣标记

**文件**: `db/schema/service.ts`
- 更新 `serviceItems` 表定义，添加 `reservedAt` 字段和索引定义

### 2. staffApi 云函数 (✅ 已完成)

**文件**: `fengyu-staff/cloudfunctions/staffApi/routes/service.js`

#### 2.1 `service.start` - 增加预扣逻辑
- 校验可用次数（`remaining_sessions - total_reserved`）
- 考虑其他服务单的预扣，排除当前服务单（幂等支持）
- 叠加 `paid_sessions` 限额校验
- 标记预扣：`UPDATE service_items SET reserved_at = NOW() WHERE service_order_id = ?`

#### 2.2 `finalizeServiceOrder` - 清除预扣标记
- 在扣减前清除预扣：`UPDATE service_items SET reserved_at = NULL WHERE service_order_id = ?`
- 防止转换单查询时重复计入本服务单的预扣

#### 2.3 `service.cancel` - 释放预扣
- 清除预扣标记：`UPDATE service_items SET reserved_at = NULL WHERE service_order_id = ?`

**文件**: `fengyu-staff/cloudfunctions/staffApi/routes/order.js`

#### 2.4 `createConversion` - 转换单考虑预扣
- 查询增加预扣统计：`LEFT JOIN service_items ... COALESCE(SUM(session_used) FILTER (WHERE reserved_at IS NOT NULL), 0) AS total_reserved`
- 可用次数 = `remaining_sessions - total_reserved`
- 折抵数量改为可用次数（而非全部剩余次数）

### 3. clientApi 云函数 (✅ 已完成)

**文件**: `fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js`

#### 3.1 `finalizeServiceOrder` - 清除预扣标记
- 同步 staffApi 的变更，在扣减前清除预扣标记

### 4. admin 后台 (✅ 已完成)

**文件**: `fengyu-admin/src/actions/services.ts`

#### 4.1 `confirmServiceOrder` - 清除预扣标记
- 在事务内、扣减前清除预扣：
  ```typescript
  await tx.execute(sql`
    UPDATE service_items
    SET reserved_at = NULL, updated_at = NOW()
    WHERE service_order_id = ${serviceOrderId}
  `)
  ```

#### 4.2 `cancelServiceOrder` - 释放预扣
- 改为事务包裹，先释放预扣，再更新服务单状态

**文件**: `fengyu-admin/src/actions/orders.ts`

#### 4.3 `createConversionOrder` - 转换单考虑预扣
- 查询增加预扣统计（LEFT JOIN service_items + GROUP BY）
- 可用次数 = `remaining_sessions - total_reserved`
- 错误消息优化：`CARD_RESERVED: 所选卡可用次数不足（存在服务中预留）`

## 跨端一致性

### SQL 副本守护
- `finalizeServiceOrder` 的清除预扣 SQL 在三端保持字面量一致：
  - `fengyu-staff/cloudfunctions/staffApi/routes/service.js`
  - `fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js`
  - `fengyu-admin/src/actions/services.ts`
- 由 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js` 守护

## 测试验证

### 手动测试场景
1. ✅ 创建服务单 → 开始服务 → 尝试转换同一卡（应拒绝，提示"存在服务中预留"）
2. ✅ 创建服务单 → 开始服务 → 取消服务 → 转换（应成功）
3. ✅ 创建服务单 → 开始服务 → 确认完成（应成功扣减）
4. ✅ 两个服务单使用同一张卡 → 第一个开始服务 → 第二个尝试开始（应拒绝）

### 自动化测试
- 待编写: `fengyu-staff/tests/e2e-cloudfn/service-reservation-conflict.spec.mjs`
- 场景覆盖:
  - 服务中创建转换单（应报错）
  - 服务取消后转换单（应成功）
  - 多个服务单并发预扣同一卡

## 部署清单

### Phase 1: 数据库迁移
- [x] 本地环境：运行 `bun db:migrate` (迁移 0079)
- [ ] Dev 环境：部署迁移到 47.113.202.7
- [ ] Prod 环境：
  - 备份数据库
  - 运行数据修复脚本（补打预扣标记）
  - 部署迁移 0079

### Phase 2: 云函数部署
- [ ] staffApi (dev/prod)
- [ ] clientApi (dev/prod)

### Phase 3: Admin 部署
- [ ] fengyu-admin (dev)
- [ ] fengyu-admin (prod)

### Phase 4: 烟雾测试
- [ ] 创建测试服务单，验证预扣流程
- [ ] 监控错误日志（关注 `INSUFFICIENT_BALANCE` / `CARD_RESERVED` 错误）

## 向后兼容性

### 旧服务单
- `reserved_at = NULL`：不影响已完成/已取消的服务单
- 进行中服务单：升级后首次 `service.start` 会触发预扣逻辑

### 数据修复
- 迁移脚本自动为"服务中"/"待客户确认"的服务单补打 `reserved_at`
- 使用 `COALESCE(started_at, created_at)` 作为预扣时间

## 风险点与缓解

### 高风险
1. **三端 SQL 一致性**: 由 snapshot 测试自动守护，改一端必触发测试失败
2. **转换单查询性能**: 新增索引 `idx_service_items_sale_item_reserved` 缓解
3. **生产升级窗口**: 数据修复脚本确保现有服务单预扣状态正确

### 中风险
1. **幂等性**: `service.start` 重入时排除当前服务单的预扣统计
2. **事务边界**: 所有预扣操作都在事务内，保证原子性

## 后续优化（可选）

1. **超时释放**: Cron job 定期清理超过 24 小时未完成的预扣
2. **监控告警**: Grafana 监控长时间预扣的服务单
3. **UI 优化**: 
   - 转换单选卡界面显示"预留中"标签
   - 服务单列表显示预扣状态

## 预期效果

用户报告的"服务期间疗程卡被转换单消耗"问题将被彻底解决：
- 服务开始时次数被预扣，转换单查询时排除预扣次数
- 服务取消时释放预扣，次数重新可用
- 服务确认时清除预扣标记 + 正式扣减，保证数据一致性
