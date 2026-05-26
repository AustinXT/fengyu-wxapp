CREATE TABLE "service_reviews" (
	"service_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"client_user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_service_order_id_service_orders_service_order_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("service_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_svc_reviews_employee" ON "service_reviews" USING btree ("employee_id");