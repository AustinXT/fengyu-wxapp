import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { staffWechatUsers } from "./user";
import { stores } from "./org";

// 微信身份按 AppID 隔离；不覆盖员工端的 OPENID。
export const dailyWechatBindings = pgTable(
  "daily_wechat_bindings",
  {
    appid: text("appid").notNull(),
    openid: text("openid").notNull(),
    employeeId: varchar("employee_id", { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.appid, t.openid] }),
    uniqueIndex("uq_daily_binding_employee").on(t.appid, t.employeeId),
  ],
);

export const dailyReports = pgTable(
  "daily_reports",
  {
    id: text("id").primaryKey(),
    employeeId: varchar("employee_id", { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    reportDate: date("report_date").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => stores.storeId),
    employeeName: text("employee_name").notNull(),
    storeName: text("store_name").notNull(),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    action: text("action").notNull().default(""),
    growth: text("growth").notNull().default(""),
    plan: text("plan").notNull().default(""),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_daily_employee_date").on(t.employeeId, t.reportDate),
    index("idx_daily_store_date").on(t.storeId, t.reportDate),
    check("chk_daily_status", sql`${t.status} IN ('draft', 'submitted')`),
    check(
      "chk_daily_submission",
      sql`(${t.status} = 'submitted') = (${t.submittedAt} IS NOT NULL)`,
    ),
    check("chk_daily_version", sql`${t.version} > 0`),
  ],
);

export const dailyReportEntries = pgTable(
  "daily_report_entries",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => dailyReports.id, { onDelete: "cascade" }),
    businessType: text("business_type").notNull(),
    businessId: text("business_id").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    feedback: text("feedback").notNull().default(""),
    followUp: text("follow_up").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_daily_entry_business").on(
      t.reportId,
      t.businessType,
      t.businessId,
    ),
    check(
      "chk_daily_business_type",
      sql`${t.businessType} IN ('service', 'sale')`,
    ),
  ],
);
