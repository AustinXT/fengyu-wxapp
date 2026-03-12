CREATE TYPE "public"."org_node_type" AS ENUM('headquarters', 'market', 'store', 'department');--> statement-breakpoint
CREATE TABLE "operation_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operator_user_id" text NOT NULL,
	"operator_name" text NOT NULL,
	"operator_role" text,
	"org_node_id" text,
	"org_node_name" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" jsonb,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "org_node_type" NOT NULL,
	"parent_id" text,
	"parent_name" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_org_nodes_parent_name" UNIQUE("parent_id","name")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"store_id" text PRIMARY KEY NOT NULL,
	"store_name" text NOT NULL,
	"org_node_id" text,
	"market_name" text NOT NULL,
	"opening_date" date,
	"bed_count" integer,
	"is_closed" boolean DEFAULT false NOT NULL,
	"cover_image" text,
	"images" text[],
	"district" text,
	"street_address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"phone" text,
	"business_hours" text,
	"description" text,
	"announcement" text,
	"parking_info" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stores_store_name_unique" UNIQUE("store_name")
);
--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_operator_user_id_staff_wechat_users_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."staff_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_parent_id_org_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_op_logs_operator" ON "operation_logs" USING btree ("operator_user_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_target" ON "operation_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_action" ON "operation_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_op_logs_created_at" ON "operation_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_type" ON "org_nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_parent_id" ON "org_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_stores_org_node_id" ON "stores" USING btree ("org_node_id");--> statement-breakpoint
CREATE INDEX "idx_stores_market_name" ON "stores" USING btree ("market_name");