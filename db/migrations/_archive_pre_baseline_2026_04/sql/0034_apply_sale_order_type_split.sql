-- 修复版的 sale_order_type 枚举迁移（migration 0030 因为列有默认值无法直接 ALTER）
-- 从旧枚举值（普通/体验/内部/回款/转换/退款/组合套餐/福利活动）→ 新值（销售单/内部单/回款单/转换单/退款单）

-- 1. 创建新枚举
CREATE TYPE "public"."sale_order_type_new" AS ENUM('销售单', '内部单', '回款单', '转换单', '退款单');

-- 2. 先 DROP DEFAULT，否则 ALTER TYPE 会因为旧默认值无法转换而失败
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" DROP DEFAULT;

-- 3. 切换列类型（兼容历史可能存在的所有旧值）
ALTER TABLE "sale_orders"
  ALTER COLUMN "sale_order_type" TYPE "public"."sale_order_type_new"
  USING (
    CASE sale_order_type::text
      WHEN '普通' THEN '销售单'
      WHEN '体验' THEN '销售单'
      WHEN '组合套餐' THEN '销售单'
      WHEN '福利活动' THEN '销售单'
      WHEN '内部' THEN '内部单'
      WHEN '回款' THEN '回款单'
      WHEN '转换' THEN '转换单'
      WHEN '退款' THEN '退款单'
    END
  )::"sale_order_type_new";

-- 4. 删除旧枚举，重命名新枚举
DROP TYPE "public"."sale_order_type";
ALTER TYPE "public"."sale_order_type_new" RENAME TO "sale_order_type";

-- 5. 重新设置默认值
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '销售单'::"sale_order_type";
