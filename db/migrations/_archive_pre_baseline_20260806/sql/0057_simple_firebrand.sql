ALTER TABLE "sale_allocations" ADD COLUMN "commission_rate" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD COLUMN "commission_amount" numeric(10, 2);