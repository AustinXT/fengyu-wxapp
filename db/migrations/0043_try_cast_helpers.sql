-- #187：安全转换 helper，供解析 sale_order_payments.note 里的退款 JSON 使用。
--
-- 背景：退款流水的行级金额权威源是 note 里的 JSON `items[].refundAmount`。
-- 原先各处用 `note LIKE '{%'` 做纯文本守门再 `::jsonb`，但 LIKE 无法证明 JSON 合法——
-- `{手工备注}`、`{"items":` 这类值会通过守门、在 cast 处抛 22P02，直接回滚整个收款事务。
-- `(elem ->> 'refundAmount')::numeric` 遇非数字文本同理。
--
-- PG16 有 `pg_input_is_valid()`，但自托管生产库版本未统一，故用 PL/pgSQL 的
-- `EXCEPTION WHEN data_exception` 实现版本无关的安全降级（PG 9.x 起即支持）。
--
-- IMMUTABLE：同一入参恒返回同值，可参与索引/内联优化。
-- STRICT：入参为 NULL 时直接返回 NULL，不进函数体。
-- 转换失败一律返回 NULL，由调用方 COALESCE 兜底——**静默降级而非报错**是有意为之：
-- 一条历史脏备注不应该让顾客的收款事务失败。

CREATE OR REPLACE FUNCTION try_jsonb(t text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION try_numeric(t text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  RETURN t::numeric;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION try_jsonb(text) IS
  '安全 jsonb 转换：非法 JSON 返回 NULL 而非抛 22P02。用于解析 sale_order_payments.note (#187)';
--> statement-breakpoint

COMMENT ON FUNCTION try_numeric(text) IS
  '安全 numeric 转换：非数字文本返回 NULL 而非抛 22P02。用于解析退款 JSON 里的 refundAmount (#187)';
