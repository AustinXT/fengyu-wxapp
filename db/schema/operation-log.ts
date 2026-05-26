import { bigserial, index, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { staffWechatUsers } from './user'
import { orgNodes } from './org'

/**
 * 操作日志表
 *
 * 记录小程序后台的关键变更操作，用于审计追踪。
 * action 格式与云函数路由一致：'module.method'（如 'order.create', 'appointment.confirm'）
 */
export const operationLogs = pgTable(
  'operation_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 操作人员工编号，关联 staff_wechat_users（系统级操作如 cronTask、payNotify 可为 null） */
    operatorEmployeeId: varchar('operator_employee_id', { length: 30 })
      .references(() => staffWechatUsers.employeeId),
    /** 操作人姓名快照（系统级操作可为 null） */
    operatorName: text('operator_name'),
    /** 操作人角色快照（manager / beautician） */
    operatorRole: text('operator_role'),
    /** 操作人所属组织节点，FK → org_nodes.id */
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    /** 操作人所属组织节点名称快照 */
    orgNodeName: text('org_node_name'),
    /** 操作动作，格式 module.method，如 order.create / service.complete */
    action: text('action').notNull(),
    /** 目标实体类型：order / order_item / appointment / service_order 等 */
    targetType: text('target_type').notNull(),
    /** 目标实体主键（如 order_no, appointment_id） */
    targetId: text('target_id').notNull(),
    /** 操作详情，存放变更前后数据、备注等结构化信息 */
    detail: jsonb('detail'),
    /** 来源：staffApi / clientApi / adminApi */
    source: text('source'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_op_logs_operator').on(table.operatorEmployeeId),
    index('idx_op_logs_target').on(table.targetType, table.targetId),
    index('idx_op_logs_action').on(table.action),
    index('idx_op_logs_created_at').on(table.createdAt),
  ],
)

export type OperationLog = typeof operationLogs.$inferSelect
export type NewOperationLog = typeof operationLogs.$inferInsert
