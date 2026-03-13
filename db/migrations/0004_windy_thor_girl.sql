-- Phase A: 扩展 staff_wechat_users 表（添加 employees 字段）
ALTER TABLE "staff_wechat_users" ADD COLUMN "name" varchar(50);--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "gender" varchar(20);--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "id_card" varchar(200);--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "store_id" text;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "org_node_id" text;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "position_name" varchar(50);--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "skills" text[];--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "is_resigned" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Phase B: 数据回填 — employees → staff_wechat_users
-- B1. 已有微信绑定的员工（phone 匹配）：回填档案字段
UPDATE staff_wechat_users u SET
  name = e.name,
  gender = e.gender,
  id_card = e.id_card,
  store_id = e.store_id,
  org_node_id = e.org_node_id,
  position_name = e.position_name,
  birthday = e.birthday,
  skills = e.skills,
  is_resigned = e.is_resigned,
  employee_id = COALESCE(u.employee_id, e.employee_id)
FROM employees e
WHERE u.employee_id = e.employee_id
   OR (u.phone IS NOT NULL AND u.phone = e.phone);--> statement-breakpoint

-- B2. 无微信绑定的员工（employees 表有、staff_wechat_users 无）：新建行（openid = null）
INSERT INTO staff_wechat_users (
  user_id, employee_id, phone, name, gender, id_card,
  store_id, org_node_id, position_name, birthday, skills, is_resigned,
  created_at, updated_at
)
SELECT
  'emp_' || e.employee_id,
  e.employee_id,
  e.phone,
  e.name,
  e.gender,
  e.id_card,
  e.store_id,
  e.org_node_id,
  e.position_name,
  e.birthday,
  e.skills,
  e.is_resigned,
  e.created_at,
  e.updated_at
FROM employees e
WHERE NOT EXISTS (
  SELECT 1 FROM staff_wechat_users u
  WHERE u.employee_id = e.employee_id
     OR (u.phone IS NOT NULL AND u.phone = e.phone)
);--> statement-breakpoint

-- Phase C: 删除旧 FK 约束（从 employees）
ALTER TABLE "staff_wechat_users" DROP CONSTRAINT IF EXISTS "staff_wechat_users_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "sale_allocations" DROP CONSTRAINT "sale_allocations_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_opened_by_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_preferred_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_offline_confirmed_by_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "service_items" DROP CONSTRAINT "service_items_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "service_orders" DROP CONSTRAINT "service_orders_assigned_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "permission_roles" DROP CONSTRAINT "permission_roles_employee_id_employees_employee_id_fk";--> statement-breakpoint
ALTER TABLE "store_unbind_requests" DROP CONSTRAINT "store_unbind_requests_reviewed_by_employees_employee_id_fk";--> statement-breakpoint

-- Phase D: 删除 employees 表
ALTER TABLE "employees" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "employees" CASCADE;--> statement-breakpoint

-- Phase E: 调整 staff_wechat_users 约束和索引
ALTER TABLE "staff_wechat_users" DROP CONSTRAINT "staff_wechat_users_openid_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_staff_users_phone";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_staff_users_employee_id";--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ALTER COLUMN "openid" DROP NOT NULL;--> statement-breakpoint

-- Phase F: 添加新 FK 约束和索引
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_opened_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_preferred_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("preferred_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_offline_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("offline_confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_assigned_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_roles" ADD CONSTRAINT "permission_roles_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_reviewed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_users_openid" ON "staff_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_users_phone" ON "staff_wechat_users" USING btree ("phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_staff_users_store_resigned" ON "staff_wechat_users" USING btree ("store_id","is_resigned");--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_employee_id_unique" UNIQUE("employee_id");
