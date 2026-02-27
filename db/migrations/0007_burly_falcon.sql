ALTER TABLE "appointments" ADD COLUMN "checkin_at" timestamp;--> statement-breakpoint
ALTER TABLE "service_orders" ADD COLUMN "appointment_id" text;