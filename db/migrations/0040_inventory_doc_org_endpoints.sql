-- 单据端点已经切换为 org_nodes.id；市场归属必须从组织节点而非库存内部主键派生。
CREATE OR REPLACE FUNCTION inventory_location_market_id(input_location_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE location_type
    WHEN '市场' THEN org_node_id
    WHEN '门店' THEN parent_location_id
    ELSE NULL
  END
    FROM inventory_locations
   WHERE org_node_id = input_location_id
$$;

CREATE OR REPLACE FUNCTION inventory_set_doc_market_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.market_id := inventory_expected_doc_market_id(
    NEW.doc_type, NEW.source_org_node_id, NEW.target_org_node_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_docs_set_market_id ON inventory_docs;
CREATE TRIGGER trg_inventory_docs_set_market_id
BEFORE INSERT OR UPDATE OF doc_type, source_org_node_id, target_org_node_id, market_id
ON inventory_docs
FOR EACH ROW EXECUTE FUNCTION inventory_set_doc_market_id();

UPDATE inventory_docs
   SET market_id = inventory_expected_doc_market_id(
     doc_type, source_org_node_id, target_org_node_id
   )
 WHERE market_id IS DISTINCT FROM inventory_expected_doc_market_id(
   doc_type, source_org_node_id, target_org_node_id
 );
