ALTER TABLE "inventory_docs" ADD COLUMN "cancellation_request_reason" text;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "cancellation_requested_by" varchar(30);--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_cancellation_requested_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("cancellation_requested_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;