CREATE TABLE "analyst_chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"visualizations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_analyst_chat_messages_role" CHECK ("analyst_chat_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "analyst_chat_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_employee_id" varchar(30) NOT NULL,
	"title" varchar(100) DEFAULT '新对话' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyst_chat_messages" ADD CONSTRAINT "analyst_chat_messages_session_id_analyst_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analyst_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_chat_sessions" ADD CONSTRAINT "analyst_chat_sessions_owner_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analyst_chat_messages_session_id" ON "analyst_chat_messages" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "idx_analyst_chat_sessions_owner_updated" ON "analyst_chat_sessions" USING btree ("owner_employee_id","updated_at","id");