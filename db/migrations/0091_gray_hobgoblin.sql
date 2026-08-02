ALTER TABLE "sale_order_payments" DROP CONSTRAINT "chk_sop_amount_sign";--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "chk_sop_amount_sign" CHECK (("sale_order_payments"."change_type" IN ('首次支付','回款','储值卡抵扣') AND "sale_order_payments"."amount" > 0)
          OR ("sale_order_payments"."change_type" = '退款' AND "sale_order_payments"."amount" <= 0));