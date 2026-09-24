-- 本次迁移对 inventory_skus 取 ACCESS EXCLUSIVE（ADD COLUMN + ADD CONSTRAINT），且该锁一直
-- 持有到整批迁移提交 —— drizzle 把**所有**待应用迁移放进同一个事务。ACCESS EXCLUSIVE 连
-- SELECT 都拦，而 inventory_skus 在 7×24 的下单主链路上被读（staffApi/clientApi 的 routes/order.js
-- 取家居产品行的 SKU 映射）。库存域目前 0 行不构成免检理由：真正的杀伤是锁队列 FIFO ——
-- 只要 ADD COLUMN 排在任意一条慢查询后面，后续所有对该表的读都堆在它后面，无限等。
-- 宁可迁移失败重来，也不要把业务卡住 —— 3 秒拿不到锁就放弃。
-- （与 0041_bizarre_wolfpack 同构；SET LOCAL 作用于整个事务，各自显式设一遍可消除
--   「取决于合并顺序才知道有没有被保护」的不确定性。）
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD COLUMN "supplier_id" text;--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_supplier_id_inventory_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."inventory_suppliers"("supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_skus_supplier" ON "inventory_skus" USING btree ("supplier_id");--> statement-breakpoint
-- ── 以下为手工追加的存量回填（db/CLAUDE.md 允许的「只追加」例外，#132）────────────
-- 口径（issue #132 评论已拍板 Q1）：按名称**精确匹配**回填 supplier_id；
-- 匹配不上的留 NULL、**不自动建档**（凭空建出的档案联系人/地址全空，比留 NULL 更脏）；
-- supplier 文本列**保留不删**，让匹配不上的值仍然可见，不至于静默丢数据。
--
-- 等值匹配的是**未加工的** v."name"，其上有唯一索引 uq_inventory_suppliers_name，
-- 所以至多命中一行，UPDATE ... FROM 不存在「多行候选时 PG 任取一行」的不确定性。
-- ⚠️ 勿给 v."name" 也套 btrim：那样 ' A ' 与 'A' 两条档案会同时命中，
--    PG 此时确实会静默任取一行且不报错。
-- btrim 只吸收 s."supplier" 首尾的空格，不做同义词/模糊匹配 —— 仍然是精确匹配。
-- supplier 文本一并归一成档案名：不归一的话，' 恒美 ' 这类值会拿到 supplier_id，
-- 但文本仍带空格 —— 列表走 JOIN 显示「恒美」、批次快照却写「 恒美 」，两个名字对不上。
UPDATE "inventory_skus" AS s
   SET "supplier_id" = v."supplier_id",
       "supplier" = v."name"
  FROM "inventory_suppliers" AS v
 WHERE s."supplier_id" IS NULL
   AND btrim(COALESCE(s."supplier", '')) <> ''
   AND btrim(s."supplier") = v."name";
