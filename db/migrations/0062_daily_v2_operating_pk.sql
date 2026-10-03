CREATE TABLE "daily_operating_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"weeks" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_daily_period_dates" CHECK ("daily_operating_periods"."start_date" <= "daily_operating_periods"."end_date"),
	CONSTRAINT "chk_daily_period_weeks" CHECK (jsonb_typeof("daily_operating_periods"."weeks") = 'array' AND jsonb_array_length("daily_operating_periods"."weeks") = 4),
	CONSTRAINT "chk_daily_period_version" CHECK ("daily_operating_periods"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_operating_targets" (
	"period_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"sales" bigint NOT NULL,
	"consumption" bigint NOT NULL,
	"penalty" text DEFAULT '' NOT NULL,
	"month_confirmed" boolean DEFAULT false NOT NULL,
	"weeks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_operating_targets_period_id_scope_scope_id_pk" PRIMARY KEY("period_id","scope","scope_id"),
	CONSTRAINT "chk_daily_target_scope" CHECK ("daily_operating_targets"."scope" IN ('personal','store','market')),
	CONSTRAINT "chk_daily_target_amount" CHECK ("daily_operating_targets"."sales" > 0 AND "daily_operating_targets"."consumption" > 0 AND "daily_operating_targets"."sales" <= 9007199254740991 AND "daily_operating_targets"."consumption" <= 9007199254740991),
	CONSTRAINT "chk_daily_target_version" CHECK ("daily_operating_targets"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_pk_classes" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"name" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_pk_stores" (
	"period_id" text NOT NULL,
	"store_id" text NOT NULL,
	"class_id" text NOT NULL,
	"legion" text DEFAULT '' NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"mentor_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_pk_stores_period_id_store_id_pk" PRIMARY KEY("period_id","store_id")
);
--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "mentor_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "peer_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "period_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "metric_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "daily_operating_targets" ADD CONSTRAINT "daily_operating_targets_period_id_daily_operating_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."daily_operating_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_pk_classes" ADD CONSTRAINT "daily_pk_classes_period_id_daily_operating_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."daily_operating_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_pk_stores" ADD CONSTRAINT "daily_pk_stores_period_id_daily_operating_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."daily_operating_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_pk_stores" ADD CONSTRAINT "daily_pk_stores_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_pk_period_id" ON "daily_pk_classes" USING btree ("period_id","id");--> statement-breakpoint
ALTER TABLE "daily_pk_stores" ADD CONSTRAINT "daily_pk_stores_period_id_class_id_daily_pk_classes_period_id_id_fk" FOREIGN KEY ("period_id","class_id") REFERENCES "public"."daily_pk_classes"("period_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_pk_period_name" ON "daily_pk_classes" USING btree ("period_id","name");--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_mentor_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("mentor_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_peer_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("peer_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;