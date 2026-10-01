-- #471: run with psql -v ON_ERROR_STOP=1 -f this file on dev.
-- This fixture executes PostgreSQL's actual DATE comparison used by both KPI branches.
BEGIN;
DO $$
DECLARE
  actual numeric;
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'sale_orders' AND column_name = 'performance_attribution_date') <> 'date' THEN
    RAISE EXCEPTION 'performance_attribution_date must be date';
  END IF;

  WITH orders(day, amount) AS (
    VALUES (DATE '2026-07-02', 10::numeric),
           (DATE '2026-07-03', 20::numeric),
           (DATE '2026-07-04', 40::numeric)
  )
  SELECT COALESCE(SUM(amount), 0) INTO actual FROM orders
  WHERE day BETWEEN DATE '2026-07-01' AND DATE '2026-07-03'
    AND day <= DATE '2026-07-03';
  IF actual <> 30 THEN RAISE EXCEPTION 'pre cutoff: %', actual; END IF;

  WITH orders(day, amount) AS (
    VALUES (DATE '2026-07-02', 10::numeric),
           (DATE '2026-07-03', 20::numeric),
           (DATE '2026-07-04', 40::numeric)
  )
  SELECT COALESCE(SUM(amount), 0) INTO actual FROM orders
  WHERE day BETWEEN DATE '2026-07-01' AND DATE '2026-07-31'
    AND day <= DATE '2026-07-03';
  IF actual <> 30 THEN RAISE EXCEPTION 'cross cutoff: %', actual; END IF;

  WITH orders(day, amount) AS (
    VALUES (DATE '2026-07-02', 10::numeric),
           (DATE '2026-07-03', 20::numeric),
           (DATE '2026-07-04', 40::numeric)
  )
  SELECT COALESCE(SUM(amount), 0) INTO actual FROM orders
  WHERE day BETWEEN DATE '2026-07-04' AND DATE '2026-07-31'
    AND day <= DATE '2026-07-03';
  IF actual <> 0 THEN RAISE EXCEPTION 'post cutoff: %', actual; END IF;
END $$;
ROLLBACK;
