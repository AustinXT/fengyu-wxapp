CREATE TABLE "daily_report_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"business_type" text NOT NULL,
	"business_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"feedback" text DEFAULT '' NOT NULL,
	"follow_up" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_daily_business_type" CHECK ("daily_report_entries"."business_type" IN ('service', 'sale'))
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"report_date" date NOT NULL,
	"store_id" text NOT NULL,
	"employee_name" text NOT NULL,
	"store_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"growth" text DEFAULT '' NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_daily_status" CHECK ("daily_reports"."status" IN ('draft', 'submitted')),
	CONSTRAINT "chk_daily_submission" CHECK (("daily_reports"."status" = 'submitted') = ("daily_reports"."submitted_at" IS NOT NULL)),
	CONSTRAINT "chk_daily_version" CHECK ("daily_reports"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_wechat_bindings" (
	"appid" text NOT NULL,
	"openid" text NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_wechat_bindings_appid_openid_pk" PRIMARY KEY("appid","openid")
);
--> statement-breakpoint
ALTER TABLE "daily_report_entries" ADD CONSTRAINT "daily_report_entries_report_id_daily_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."daily_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_wechat_bindings" ADD CONSTRAINT "daily_wechat_bindings_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_entry_business" ON "daily_report_entries" USING btree ("report_id","business_type","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_employee_date" ON "daily_reports" USING btree ("employee_id","report_date");--> statement-breakpoint
CREATE INDEX "idx_daily_store_date" ON "daily_reports" USING btree ("store_id","report_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_binding_employee" ON "daily_wechat_bindings" USING btree ("appid","employee_id");