-- #365 供应商市场归属候选；仅供私有库验证。
-- 集中集成时从最新 dev 的 schema 由 db:generate 生成正式 SQL/meta/journal。
-- 本文件不登记 Drizzle journal，不允许直接作为 dev/prod 发布入口。
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "inventory_suppliers" ADD COLUMN "owner_market_id" text;
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_owner_market_id_org_nodes_id_fk"
  FOREIGN KEY ("owner_market_id") REFERENCES "public"."org_nodes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
DROP INDEX "uq_inventory_suppliers_name";
CREATE UNIQUE INDEX "uq_inventory_suppliers_shared_name" ON "inventory_suppliers" USING btree ("name") WHERE "owner_market_id" IS NULL;
CREATE UNIQUE INDEX "uq_inventory_suppliers_market_name" ON "inventory_suppliers" USING btree ("owner_market_id", "name") WHERE "owner_market_id" IS NOT NULL;
CREATE INDEX "idx_inventory_suppliers_owner_market" ON "inventory_suppliers" USING btree ("owner_market_id");
COMMIT;
