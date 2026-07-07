import { bigserial, index, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { staffWechatUsers } from './user'
import { orgNodes } from './org'


export const operationLogs = pgTable(
  'operation_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    
    operatorEmployeeId: varchar('operator_employee_id', { length: 30 })
      .references(() => staffWechatUsers.employeeId),
    
    operatorName: text('operator_name'),
    
    operatorRole: text('operator_role'),
    
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    
    orgNodeName: text('org_node_name'),
    
    action: text('action').notNull(),
    
    targetType: text('target_type').notNull(),
    
    targetId: text('target_id').notNull(),
    
    detail: jsonb('detail'),
    
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
