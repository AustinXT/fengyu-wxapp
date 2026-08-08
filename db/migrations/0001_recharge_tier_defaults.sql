-- Keep existing environments aligned with the recharge pricing used by all clients.
INSERT INTO "system_configs" ("key", "value") VALUES
  ('recharge.tiers', '[{"faceValue":500,"payAmount":495},{"faceValue":1000,"payAmount":980},{"faceValue":5000,"payAmount":4750}]'),
  ('recharge.minAmount', '500'),
  ('recharge.maxAmount', '100000')
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value"
WHERE "system_configs"."value" IS DISTINCT FROM EXCLUDED."value";
