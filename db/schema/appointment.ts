import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { appointmentStatusEnum } from "./enums";
import { clientWechatUsers } from "./user";
import { orderItems } from "./order";

/**
 * 实体五：预约
 *
 * 状态流转：
 *   待确认 -> 已确认 -> 已完成（到店核销完成后自动流转）
 *   待确认 -> 已取消（顾客取消）
 *   已确认 -> 已取消（顾客取消）
 *   待确认/已确认 -> 已关闭（超过预约时间一天未到店）
 */
export const appointments = pgTable(
  "appointments",
  {
    appointmentId: text("appointment_id").primaryKey(),
    status: appointmentStatusEnum("status").notNull().default("待确认"),
    marketName: text("market_name").notNull(),
    storeName: text("store_name").notNull(),
    clientUserId: text("client_user_id")
      .notNull()
      .references(() => clientWechatUsers.userId),
    /** 顾客姓名，冗余存储 */
    customerName: text("customer_name").notNull(),
    /** 关联 WorkFine UDT_S_287.UDF_S_1147 */
    staffWfId: text("staff_wf_id").notNull(),
    /** 美容师姓名，冗余存储 */
    staffName: text("staff_name").notNull(),
    /** 关联 order_items.item_flow_no，可选（允许不关联具体项目） */
    itemFlowNo: text("item_flow_no").references(() => orderItems.itemFlowNo),
    appointmentTime: timestamp("appointment_time").notNull(),
    notes: text("notes"),
    cancelledReason: text("cancelled_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_appts_client_user_id").on(table.clientUserId),
    index("idx_appts_staff_time").on(table.staffWfId, table.appointmentTime),
  ],
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
