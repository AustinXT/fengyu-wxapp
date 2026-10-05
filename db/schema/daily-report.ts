import {
  check,
  bigint,
  boolean,
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
  foreignKey,
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
    mentorEmployeeId: varchar("mentor_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    peerEmployeeId: varchar("peer_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    periodSnapshot: jsonb("period_snapshot"),
    metricSnapshot: jsonb("metric_snapshot"),
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

const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dailyOperatingPeriods = pgTable('daily_operating_periods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  weeks: jsonb('weeks').notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns(),
}, (t) => [
  check('chk_daily_period_dates', sql`${t.startDate} <= ${t.endDate}`),
  check('chk_daily_period_weeks', sql`jsonb_typeof(${t.weeks}) = 'array' AND jsonb_array_length(${t.weeks}) = 4`),
  check('chk_daily_period_version', sql`${t.version} > 0`),
]);

export const dailyOperatingTargets = pgTable('daily_operating_targets', {
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  scope: text('scope').notNull(),
  scopeId: text('scope_id').notNull(),
  sales: bigint('sales', { mode: 'number' }).notNull(),
  consumption: bigint('consumption', { mode: 'number' }).notNull(),
  penalty: text('penalty').notNull().default(''),
  monthConfirmed: boolean('month_confirmed').notNull().default(false),
  weeks: jsonb('weeks').notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  ...auditColumns(),
}, (t) => [
  primaryKey({ columns: [t.periodId, t.scope, t.scopeId] }),
  check('chk_daily_target_scope', sql`${t.scope} IN ('personal','store','market')`),
  check('chk_daily_target_amount', sql`${t.sales} > 0 AND ${t.consumption} > 0 AND ${t.sales} <= 9007199254740991 AND ${t.consumption} <= 9007199254740991`),
  check('chk_daily_target_version', sql`${t.version} > 0`),
]);

export const dailyPkClasses = pgTable('daily_pk_classes', {
  id: text('id').primaryKey(),
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  name: varchar('name', { length: 30 }).notNull(),
  ...auditColumns(),
}, (t) => [
  uniqueIndex('uq_daily_pk_period_name').on(t.periodId, t.name),
  uniqueIndex('uq_daily_pk_period_id').on(t.periodId, t.id),
]);

export const dailyPkStores = pgTable('daily_pk_stores', {
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  storeId: text('store_id').notNull().references(() => stores.storeId),
  classId: text('class_id').notNull(),
  legion: text('legion').notNull().default(''),
  groupName: text('group_name').notNull().default(''),
  mentorName: text('mentor_name').notNull().default(''),
  ...auditColumns(),
}, (t) => [
  primaryKey({ columns: [t.periodId, t.storeId] }),
  foreignKey({ columns: [t.periodId, t.classId], foreignColumns: [dailyPkClasses.periodId, dailyPkClasses.id] }),
]);

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
