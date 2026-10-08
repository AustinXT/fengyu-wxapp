-- 候选迁移：只在独立测试库验证；正式迁移由集中集成生成。
ALTER TABLE daily_operating_periods DROP CONSTRAINT chk_daily_period_weeks;
ALTER TABLE daily_operating_periods ADD CONSTRAINT chk_daily_period_weeks
  CHECK (jsonb_typeof(weeks)='array' AND jsonb_array_length(weeks) BETWEEN 1 AND 31);
