ALTER TABLE "sale_allocations" DROP CONSTRAINT "chk_sale_alloc_ratio";--> statement-breakpoint
ALTER TABLE "service_commissions" DROP CONSTRAINT "chk_svc_comm_alloc_ratio";--> statement-breakpoint
ALTER TABLE "sale_allocations" ALTER COLUMN "allocation_ratio" SET DATA TYPE numeric(5, 3);--> statement-breakpoint
ALTER TABLE "service_commissions" ALTER COLUMN "allocation_ratio" SET DATA TYPE numeric(5, 3);--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "chk_sale_alloc_ratio" CHECK ("sale_allocations"."allocation_ratio" >= 0 AND "sale_allocations"."allocation_ratio" <= 1);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_alloc_ratio" CHECK ("service_commissions"."allocation_ratio" IS NULL OR ("service_commissions"."allocation_ratio" >= 0 AND "service_commissions"."allocation_ratio" <= 1));