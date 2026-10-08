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
import { orgNodes, stores } from "./org";

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

export const dailyOperatingPeriodTemplates = pgTable('daily_operating_period_templates', {
  id: text('id').primaryKey(),
  regionId: text('region_id').references(() => orgNodes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  pattern: jsonb('pattern').notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns(),
}, (t) => [
  check('chk_daily_period_template_version', sql`${t.version} > 0`),
  uniqueIndex('uq_daily_period_template_global').on(t.name).where(sql`${t.regionId} IS NULL`),
  uniqueIndex('uq_daily_period_template_region').on(t.regionId).where(sql`${t.regionId} IS NOT NULL`),
]);

export const dailyOperatingPeriodOverrides = pgTable('daily_operating_period_overrides', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull().references(() => dailyOperatingPeriodTemplates.id, { onDelete: 'cascade' }),
  regionId: text('region_id').references(() => orgNodes.id, { onDelete: 'cascade' }),
  monthKey: varchar('month_key', { length: 7 }).notNull(),
  pattern: jsonb('pattern').notNull(),
  createdBy: text('created_by').notNull().default(''),
  ...auditColumns(),
}, (t) => [
  uniqueIndex('uq_daily_period_override_global').on(t.templateId, t.monthKey).where(sql`${t.regionId} IS NULL`),
  uniqueIndex('uq_daily_period_override_region').on(t.templateId, t.monthKey, t.regionId).where(sql`${t.regionId} IS NOT NULL`),
  check('chk_daily_period_override_month', sql`${t.monthKey} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
]);

export const dailyOperatingPeriods = pgTable('daily_operating_periods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  weeks: jsonb('weeks').notNull(),
  regionId: text('region_id').references(() => orgNodes.id),
  monthKey: varchar('month_key', { length: 7 }),
  templateId: text('template_id').references(() => dailyOperatingPeriodTemplates.id, { onDelete: 'set null' }),
  templateSource: text('template_source').notNull().default('legacy'),
  version: integer('version').notNull().default(1),
  ...auditColumns(),
}, (t) => [
  check('chk_daily_period_dates', sql`${t.startDate} <= ${t.endDate}`),
  check('chk_daily_period_weeks', sql`jsonb_typeof(${t.weeks}) = 'array' AND jsonb_array_length(${t.weeks}) BETWEEN 1 AND 31`),
  check('chk_daily_period_version', sql`${t.version} > 0`),
  check('chk_daily_period_template_source', sql`${t.templateSource} IN ('legacy','global-template','region-template','month-override','manual')`),
  check('chk_daily_period_month_key', sql`${t.monthKey} IS NULL OR ${t.monthKey} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
  uniqueIndex('uq_daily_period_region_month').on(t.regionId, t.monthKey).where(sql`${t.regionId} IS NOT NULL AND ${t.monthKey} IS NOT NULL`),
  uniqueIndex('uq_daily_period_global_month').on(t.monthKey).where(sql`${t.regionId} IS NULL AND ${t.monthKey} IS NOT NULL`),
  index('ix_daily_period_region_dates').on(t.regionId, t.startDate, t.endDate),
]);

export const dailyOperatingPeriodStores = pgTable('daily_operating_period_stores', {
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id, { onDelete: 'cascade' }),
  storeId: text('store_id').notNull().references(() => stores.storeId),
  ...auditColumns(),
}, (t) => [
  primaryKey({ columns: [t.periodId, t.storeId] }),
  index('ix_daily_period_store_store').on(t.storeId, t.periodId),
]);

export const dailyOperatingTargets = pgTable('daily_operating_targets', {
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  scope: text('scope').notNull(),
  scopeId: text('scope_id').notNull(),
  sales: bigint('sales', { mode: 'number' }).notNull(),
  consumption: bigint('consumption', { mode: 'number' }).notNull(),
  visits: integer('visits'),
  newCustomers: integer('new_customers'),
  projects: integer('projects'),
  countsMonthConfirmed: boolean('counts_month_confirmed').notNull().default(false),
  penalty: text('penalty').notNull().default(''),
  monthConfirmed: boolean('month_confirmed').notNull().default(false),
  weeks: jsonb('weeks').notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  ...auditColumns(),
}, (t) => [
  primaryKey({ columns: [t.periodId, t.scope, t.scopeId] }),
  check('chk_daily_target_scope', sql`${t.scope} IN ('personal','store','market')`),
  check('chk_daily_target_amount', sql`${t.sales} > 0 AND ${t.consumption} > 0 AND ${t.sales} <= 9007199254740991 AND ${t.consumption} <= 9007199254740991`),
  check('chk_daily_target_counts', sql`(${t.visits} IS NULL OR ${t.visits} >= 0) AND (${t.newCustomers} IS NULL OR ${t.newCustomers} >= 0) AND (${t.projects} IS NULL OR ${t.projects} >= 0) AND (NOT ${t.countsMonthConfirmed} OR (${t.visits} IS NOT NULL AND ${t.newCustomers} IS NOT NULL AND ${t.projects} IS NOT NULL))`),
  check('chk_daily_target_version', sql`${t.version} > 0`),
]);

export const dailyPkClasses = pgTable('daily_pk_classes', {
  id: text('id').primaryKey(),
  monthKey: varchar('month_key', { length: 7 }),
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  name: varchar('name', { length: 30 }).notNull(),
  ...auditColumns(),
}, (t) => [
  uniqueIndex('uq_daily_pk_month_name').on(t.monthKey, t.name),
  uniqueIndex('uq_daily_pk_month_id').on(t.monthKey, t.id),
  check('chk_daily_pk_class_month', sql`${t.monthKey} IS NULL OR ${t.monthKey} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  uniqueIndex('uq_daily_pk_period_name').on(t.periodId, t.name),
  uniqueIndex('uq_daily_pk_period_id').on(t.periodId, t.id),
]);

export const dailyPkStores = pgTable('daily_pk_stores', {
  monthKey: varchar('month_key', { length: 7 }),
  periodId: text('period_id').notNull().references(() => dailyOperatingPeriods.id),
  storeId: text('store_id').notNull().references(() => stores.storeId),
  classId: text('class_id').notNull(),
  legion: text('legion').notNull().default(''),
  groupName: text('group_name').notNull().default(''),
  mentorName: text('mentor_name').notNull().default(''),
  ...auditColumns(),
}, (t) => [
  primaryKey({ columns: [t.periodId, t.storeId] }),
  uniqueIndex('uq_daily_pk_month_store').on(t.monthKey, t.storeId),
  check('chk_daily_pk_store_month', sql`${t.monthKey} IS NULL OR ${t.monthKey} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  foreignKey({ columns: [t.monthKey, t.classId], foreignColumns: [dailyPkClasses.monthKey, dailyPkClasses.id] }),
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
