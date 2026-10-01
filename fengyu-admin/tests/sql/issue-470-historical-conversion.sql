-- #470 固定数据行为回归：与 admin/staff 到店池①的谓词及两端一致性守护配套。
-- 用法：psql -X -v ON_ERROR_STOP=1 -f fengyu-admin/tests/sql/issue-470-historical-conversion.sql
-- 显式只读；不依赖业务表的当前数据，运行任何 PG 测试库均可。
BEGIN READ ONLY;
DO $fixture$
DECLARE failures integer;
BEGIN
  WITH cases(id, customer_type, became_member_at, expected) AS (
    VALUES
      ('period_conversion', '会员客', DATE '2026-07-20', TRUE),
      ('later_conversion', '会员客', DATE '2026-08-15', TRUE),
      ('prior_member', '会员客', DATE '2026-06-20', FALSE),
      ('never_member_experience', '体验客', NULL::date, TRUE),
      ('never_member_traffic', '流量客', NULL::date, FALSE)
  )
  SELECT COUNT(*) INTO failures FROM cases
  WHERE COALESCE(
    (became_member_at IS NULL AND customer_type IN ('体验客', '小美客'))
    OR became_member_at >= DATE '2026-07-08', FALSE
  ) IS DISTINCT FROM expected;
  IF failures <> 0 THEN RAISE EXCEPTION '#470 fixed cases failed: %', failures; END IF;

  -- 同一体验客在后来转会员前后都属于旧区间；期初已会员始终不属于旧区间。
  WITH states(id, before_type, before_member_at, after_type, after_member_at, expected) AS (
    VALUES
      ('later_converts', '体验客', NULL::date, '会员客', DATE '2026-08-15', TRUE),
      ('prior_member', '会员客', DATE '2026-06-20', '会员客', DATE '2026-06-20', FALSE)
  )
  SELECT COUNT(*) INTO failures FROM states
  WHERE COALESCE((before_member_at IS NULL AND before_type IN ('体验客','小美客'))
    OR before_member_at >= DATE '2026-07-08', FALSE) IS DISTINCT FROM expected
    OR COALESCE((after_member_at IS NULL AND after_type IN ('体验客','小美客'))
    OR after_member_at >= DATE '2026-07-08', FALSE) IS DISTINCT FROM expected;
  IF failures <> 0 THEN RAISE EXCEPTION '#470 repeat-state cases failed: %', failures; END IF;
END
$fixture$;
ROLLBACK;
