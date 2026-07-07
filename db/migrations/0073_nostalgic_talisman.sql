ALTER TABLE "lakala_merchants" ADD COLUMN "market_org_node_id" text;--> statement-breakpoint
ALTER TABLE "lakala_merchants" ADD CONSTRAINT "lakala_merchants_market_org_node_id_org_nodes_id_fk" FOREIGN KEY ("market_org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_lakala_merchants_market_org_node_id" ON "lakala_merchants" USING btree ("market_org_node_id");--> statement-breakpoint



UPDATE "lakala_merchants" lm SET "market_org_node_id" = (
  SELECT m.id FROM stores s
  JOIN org_nodes sn ON sn.id = s.org_node_id
  JOIN org_nodes m ON m.id = sn.parent_id AND m.type = '市场'
  WHERE s.lakala_merchant_id = lm.id
  ORDER BY s.store_id
  LIMIT 1
) WHERE EXISTS (SELECT 1 FROM stores s2 WHERE s2.lakala_merchant_id = lm.id);