ALTER TABLE "stores" ADD COLUMN "closed_at" date;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "hired_at" date;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "resigned_at" date;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 数据回填（追加部分，drizzle-kit 不会生成；ticket 2026-04-25-mgmt-dashboard-metrics-date-alignment T3+T4）
-- ─────────────────────────────────────────────────────────────────────────────

-- T3-A: staff_wechat_users.hired_at 兜底（NULL → created_at::date）
-- TODO: WorkFine SQL Server 当前无"入职日期"字段（UDT_S_287 仅 UDF_S_1149=birthday），
-- 待业务确认是否新增字段或由 admin 表单维护后再回写。
UPDATE staff_wechat_users
   SET hired_at = created_at::date
 WHERE hired_at IS NULL;
--> statement-breakpoint

-- T3-B: staff_wechat_users.resigned_at 兜底（is_resigned=TRUE 且 resigned_at IS NULL → updated_at::date）
UPDATE staff_wechat_users
   SET resigned_at = updated_at::date
 WHERE is_resigned = TRUE
   AND resigned_at IS NULL;
--> statement-breakpoint

-- T4-A: stores.closed_at 兜底（is_closed=TRUE 且 closed_at IS NULL → updated_at::date）
UPDATE stores
   SET closed_at = updated_at::date
 WHERE is_closed = TRUE
   AND closed_at IS NULL;
--> statement-breakpoint

-- T4-B: stores.opening_date 兜底（NULL → created_at::date；本库存在 NULL 行，需补齐）
UPDATE stores
   SET opening_date = created_at::date
 WHERE opening_date IS NULL;