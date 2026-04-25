ALTER TABLE "service_items" ADD COLUMN "sales_category" "sales_category";

-- 历史回填：service_items.sales_category ← sale_items.sales_category
-- service_items.sale_item_id 是 NOT NULL FK，sale_items.sales_category 也已经历史回填过
UPDATE service_items sit
SET sales_category = si.sales_category
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.sales_category IS NULL;
