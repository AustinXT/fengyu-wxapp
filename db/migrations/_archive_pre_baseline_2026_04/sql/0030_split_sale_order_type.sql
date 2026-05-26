-- sale_order_type 枚举重构：普通/体验/内部/组合套餐/回款/转换/退款 → 销售单/内部单/回款单/转换单/退款单

-- 1. 创建新枚举
CREATE TYPE "public"."sale_order_type_new" AS ENUM('销售单', '内部单', '回款单', '转换单', '退款单');

-- 2. 切换列类型（兼容 DB 中可能存在的 '福利活动'）
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

-- 3. 删除旧枚举，重命名新枚举
DROP TYPE "public"."sale_order_type";
ALTER TYPE "public"."sale_order_type_new" RENAME TO "sale_order_type";

-- 4. 设置默认值
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '销售单'::"sale_order_type";
