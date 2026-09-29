-- #270: refuse existing collisions; never guess how to repair a historical identity.
DO $$
DECLARE collided_id text;
BEGIN
  SELECT s.store_id INTO collided_id
    FROM stores s JOIN org_nodes o ON o.id = s.store_id
   WHERE o.type IN ('总部', '市场') ORDER BY s.store_id LIMIT 1;
  IF collided_id IS NOT NULL THEN
    RAISE EXCEPTION 'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识 % 与总部/市场组织节点冲突', collided_id;
  END IF;
END;
$$;
--> statement-breakpoint
-- Separate from 0009's tree validation to avoid overwriting its existing invariants.
-- ON CONFLICT runs both INSERT and UPDATE triggers. The OLD/NEW check is essential:
-- under concurrent source inserts, cross-table reads alone may not see the other tx,
-- but the conflicting inventory_locations PK serializes the eventual UPDATE.
CREATE FUNCTION inventory_guard_location_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.location_type = '门店' AND EXISTS (
        SELECT 1 FROM org_nodes WHERE id = NEW.location_id AND type IN ('总部', '市场')
      )) OR (NEW.location_type IN ('总部', '市场') AND EXISTS (
        SELECT 1 FROM stores WHERE store_id = NEW.location_id
      )) THEN
    RAISE EXCEPTION 'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识 % 与总部/市场组织节点冲突', NEW.location_id;
  END IF;
  IF TG_OP = 'UPDATE' AND (
       (OLD.location_type = '门店' AND NEW.location_type IN ('总部', '市场'))
    OR (OLD.location_type IN ('总部', '市场') AND NEW.location_type = '门店')
  ) THEN
    RAISE EXCEPTION 'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识 % 不能改写为另一类主体', NEW.location_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_inventory_locations_guard_identity
BEFORE INSERT OR UPDATE ON inventory_locations
FOR EACH ROW EXECUTE FUNCTION inventory_guard_location_identity();
