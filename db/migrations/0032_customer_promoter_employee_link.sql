ALTER TABLE "client_wechat_users" ADD COLUMN "promoter_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_promoter_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("promoter_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_client_users_promoter_employee_id" ON "client_wechat_users" USING btree ("promoter_employee_id") WHERE promoter_employee_id IS NOT NULL;
