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
-- IMMUTABLE：同一入参恒返回同值（text→jsonb / text→numeric 是纯函数，不受 GUC/locale 影响）。
-- STRICT：入参 NULL 直接返回 NULL，不进函数体——最常见的「note 为 NULL」路径免建子事务。
-- SET search_path = ''：函数体只用内建类型 cast（pg_catalog 恒隐式可见），当前无注入面；
--   显式固定是防御性的——PL/pgSQL 本就不可 inline，零性能代价。
--
-- ⚠️ 捕获范围**必须**保持 `data_exception`（SQLSTATE class 22）：
--   函数体只有一条 cast，class 22 内实际可抛的就是 22P02（格式非法）与 22003（数值超界）。
--   **绝不可改成 `WHEN OTHERS`** —— 那会连查询取消(57014)、OOM(53200)、锁超时(55P03) 一起吞掉。
--
-- 转换失败一律返回 NULL，由调用方 COALESCE 兜底——**静默降级而非报错**是有意为之：
-- 一条历史脏备注不应该让顾客的收款事务失败。降级方向单调偏保守（少算退款 → 更难升级）。
--
-- ⚠️ 若日后基于这两个函数建表达式索引（IMMUTABLE 允许），CREATE OR REPLACE 改定义前必须先 DROP 索引。

CREATE OR REPLACE FUNCTION public.try_jsonb(t text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;
--> statement-breakpoint

-- NaN / ±Infinity 是 numeric 的合法字面量（PG14+ 起 Infinity 也是），cast 不会抛错，
-- 但它们进 SUM 会污染整列，且 `LEAST(NaN, sale_amount)` 在 PG 里 NaN 排最大 ⇒ 取 sale_amount 满额，
-- 是唯一偏「误升」方向的边角。这里显式拦掉（用 ::text 比较，避免 PG<14 解析 'Infinity' 报错）。
CREATE OR REPLACE FUNCTION public.try_numeric(t text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
  v numeric;
BEGIN
  v := t::numeric;
  IF v::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RETURN NULL;
  END IF;
  RETURN v;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION public.try_jsonb(text) IS
  '安全 jsonb 转换：非法 JSON 返回 NULL 而非抛 22P02。用于解析 sale_order_payments.note (#187)。改定义前先 DROP 依赖的表达式索引。';
--> statement-breakpoint

COMMENT ON FUNCTION public.try_numeric(text) IS
  '安全 numeric 转换：非数字文本、NaN、±Infinity 均返回 NULL 而非抛 22P02 或污染聚合。用于解析退款 JSON 的 refundAmount (#187)。';
