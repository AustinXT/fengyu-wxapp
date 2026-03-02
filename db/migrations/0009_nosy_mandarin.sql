CREATE TYPE "public"."store_unbind_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "store_unbind_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_store_name" text NOT NULL,
	"status" "store_unbind_request_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"reject_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
