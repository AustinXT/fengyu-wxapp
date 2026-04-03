-- 冗余字段：绑定美容师姓名，避免查询时 LEFT JOIN staff_wechat_users
ALTER TABLE "client_wechat_users" ADD COLUMN "bound_employee_name" varchar(50);

-- 回填存量数据
UPDATE "client_wechat_users" c
SET "bound_employee_name" = s."name"
FROM "staff_wechat_users" s
WHERE c."bound_employee_id" = s."employee_id"
  AND c."bound_employee_id" IS NOT NULL;
