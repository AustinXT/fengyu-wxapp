-- Add role_type and allocation_ratio columns to service_commissions
ALTER TABLE "service_commissions" ADD COLUMN "role_type" varchar(20);
ALTER TABLE "service_commissions" ADD COLUMN "allocation_ratio" numeric(5, 2);

-- Drop old unique index and create new one including role_type
DROP INDEX IF EXISTS "uq_svc_comm_item_emp";
CREATE UNIQUE INDEX "uq_svc_comm_item_emp_role" ON "service_commissions" ("service_item_id","employee_id","role_type") WHERE is_void = false;
