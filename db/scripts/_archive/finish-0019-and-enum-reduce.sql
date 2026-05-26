-- M3 已成功执行（operator_employee_id / note 已 DROP）

-- M6: sale_order_type 5→3（需先 DROP DEFAULT 消除依赖）
BEGIN;

DO $$
DECLARE _cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO _cnt FROM sale_orders WHERE sale_order_type IN ('回款单', '退款单');
    IF _cnt > 0 THEN
        RAISE EXCEPTION 'M6 ABORT: sale_orders still has % rows of type 回款单/退款单', _cnt;
    END IF;
END $$;

-- 先删除默认值
ALTER TABLE sale_orders ALTER COLUMN sale_order_type DROP DEFAULT;

-- 列改 text
ALTER TABLE sale_orders ALTER COLUMN sale_order_type TYPE text;

-- 删除旧 enum（现在无依赖了）
DROP TYPE sale_order_type;

-- 创建新 enum（3 值）
CREATE TYPE sale_order_type AS ENUM ('销售单', '内部单', '转换单');

-- 列改回新 enum
ALTER TABLE sale_orders ALTER COLUMN sale_order_type TYPE sale_order_type USING sale_order_type::text::sale_order_type;

-- 重新设默认值
ALTER TABLE sale_orders ALTER COLUMN sale_order_type SET DEFAULT '销售单';

COMMIT;

-- 校验
DO $$
DECLARE
    _cnt INTEGER;
    _enum_vals TEXT;
BEGIN
    SELECT COUNT(*) INTO _cnt
    FROM information_schema.columns
    WHERE table_name = 'sale_order_payments'
      AND column_name IN ('operator_employee_id', 'note');
    IF _cnt > 0 THEN
        RAISE EXCEPTION 'CHECK FAILED: sale_order_payments still has redundant columns';
    END IF;
    RAISE NOTICE '✅ sale_order_payments columns dropped';

    SELECT string_agg(enumlabel, ', ' ORDER BY enumsortorder) INTO _enum_vals
    FROM pg_enum
    WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'sale_order_type');
    IF _enum_vals != '销售单, 内部单, 转换单' THEN
        RAISE EXCEPTION 'CHECK FAILED: sale_order_type enum = "%"', _enum_vals;
    END IF;
    RAISE NOTICE '✅ sale_order_type = 销售单, 内部单, 转换单';

    SELECT COUNT(*) INTO _cnt FROM sale_orders WHERE sale_order_type IN ('回款单', '退款单');
    IF _cnt > 0 THEN
        RAISE EXCEPTION 'CHECK FAILED: % 回款单/退款单 rows remain', _cnt;
    END IF;
    RAISE NOTICE '✅ ALL CHECKS PASSED';
END $$;
