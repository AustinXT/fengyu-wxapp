-- 本次迁移对 commission_rate_matrix 取 ACCESS EXCLUSIVE（ADD COLUMN + UPDATE + ADD CONSTRAINT 全表扫描），
-- 且该锁一直持有到整批迁移提交 —— drizzle 把**所有**待应用迁移放进同一个事务。该表在服务单确认
-- （staffApi/clientApi finalize、admin 代确认）与服务提成保存的主链路上被读；表只有几十行不构成免检理由，
-- 真正的杀伤是锁队列 FIFO：排在任意一条慢查询后面，后续所有读矩阵的请求都堆在它后面。
-- 3 秒拿不到锁就放弃（与 0041 / 0042 同构）。
-- ⚠ 上线顺序：必须先迁本迁移、再发 staffApi / clientApi / admin —— 新代码 SELECT price_threshold，未迁库即 42703。
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "commission_rate_matrix" ADD COLUMN "price_threshold" numeric(10, 2);--> statement-breakpoint
-- #379 默认阈值 100：仅服务单的自销自耗 / 他销自耗行（09-18 会议拍板；按区域差异由 admin 矩阵页逐行改）
UPDATE "commission_rate_matrix" SET "price_threshold" = 100 WHERE "order_type" = '服务单' AND "sales_category" IN ('自销自耗', '他销自耗');--> statement-breakpoint
ALTER TABLE "commission_rate_matrix" ADD CONSTRAINT "chk_commission_matrix_price_threshold" CHECK ("commission_rate_matrix"."price_threshold" IS NULL OR ("commission_rate_matrix"."price_threshold" >= 0 AND "commission_rate_matrix"."order_type" = '服务单' AND "commission_rate_matrix"."sales_category" IN ('自销自耗', '他销自耗')));