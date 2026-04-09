-- Add role_type column to sale_allocations
ALTER TABLE "sale_allocations" ADD COLUMN "role_type" varchar(20);

-- Drop old unique index and create new one including role_type
DROP INDEX IF EXISTS "uq_sale_alloc_item_emp";
CREATE UNIQUE INDEX "uq_sale_alloc_item_emp_role" ON "sale_allocations" ("sale_item_id","employee_id","role_type") WHERE is_void = false;
