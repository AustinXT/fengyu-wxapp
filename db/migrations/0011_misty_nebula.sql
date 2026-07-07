ALTER TABLE "service_items" ADD COLUMN "sales_category" "sales_category";



UPDATE service_items sit
SET sales_category = si.sales_category
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.sales_category IS NULL;
