CREATE TYPE "public"."position_scope" AS ENUM('headquarters', 'market', 'store');--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" "position_scope" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_positions_name_scope" UNIQUE("name","scope")
);
--> statement-breakpoint
CREATE TABLE "skill_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tags_name_unique" UNIQUE("name")
);
