







UPDATE service_commissions
SET commission_rate   = 0,
    consume_amount    = 0,
    commission_amount = fixed_fee
WHERE commission_rate < 0 OR commission_rate > 1;
--> statement-breakpoint


DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad FROM service_commissions
   WHERE commission_rate < 0 OR commission_rate > 1;
  IF bad > 0 THEN
    RAISE EXCEPTION 'commission_rate 清洗后仍有 % 行脏数据', bad;
  END IF;
END $$;
--> statement-breakpoint


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_svc_comm_commission_rate'
       AND conrelid = 'service_commissions'::regclass
  ) THEN
    ALTER TABLE service_commissions
      ADD CONSTRAINT chk_svc_comm_commission_rate
      CHECK (commission_rate >= 0 AND commission_rate <= 1);
  END IF;
END $$;
