-- 2026-05-17 service_commissions.commission_rate 清洗 + 补加 CHECK 约束
-- 关联 ticket: notes/tickets/2026-04-27-allocation-ratio-check-constraint.md §3 第 1 项
-- 背景：0022/0023 因历史 59,966 行 rate>1 脏数据 ADD CONSTRAINT 失败被跳过；
-- 5434 主库脏数据已为 0（2026-05-17 诊断确认），本 migration 兜底 5433 冷备 + 补 CHECK。
-- 清洗策略：Plan B 全部归零（与新写入路径 admin service-commissions.ts:212 /
-- staff service.js:412 的"矩阵无匹配置 0"行为完全一致，零资损风险）。

-- 1. 清洗兜底（5434 上是 no-op；5433 冷备如有脏数据会被一并归零）
UPDATE service_commissions
SET commission_rate   = 0,
    consume_amount    = 0,
    commission_amount = fixed_fee
WHERE commission_rate < 0 OR commission_rate > 1;
--> statement-breakpoint

-- 2. 验证：清洗后必为 0 行
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

-- 3. ADD CONSTRAINT（IF NOT EXISTS 兼容 0022/0023 已部分部署的库）
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
