ALTER TABLE daily_operating_targets
  ADD COLUMN visits integer,
  ADD COLUMN new_customers integer,
  ADD COLUMN projects integer,
  ADD COLUMN counts_month_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE daily_operating_targets ADD CONSTRAINT chk_daily_target_counts CHECK (
  (visits IS NULL OR visits >= 0) AND (new_customers IS NULL OR new_customers >= 0)
  AND (projects IS NULL OR projects >= 0)
  AND (NOT counts_month_confirmed OR (visits IS NOT NULL AND new_customers IS NOT NULL AND projects IS NOT NULL))
);
