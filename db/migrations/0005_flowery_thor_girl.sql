CREATE TABLE "point_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_transaction_id" bigint NOT NULL,
	"source_type" text NOT NULL,
	"ref_order_id" varchar(30),
	"original_amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	"expire_at" timestamp with time zone NOT NULL,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_point_batches_original_positive" CHECK ("point_batches"."original_amount" > 0),
	CONSTRAINT "chk_point_batches_remaining_range" CHECK ("point_batches"."remaining_amount" >= 0 AND "point_batches"."remaining_amount" <= "point_batches"."original_amount"),
	CONSTRAINT "chk_point_batches_expire_after_earned" CHECK ("point_batches"."expire_at" > "point_batches"."earned_at")
);
--> statement-breakpoint
ALTER TABLE "point_transactions" DROP CONSTRAINT "chk_pt_amount_sign";--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "points_used" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "points_discount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "point_batches" ADD CONSTRAINT "point_batches_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_batches" ADD CONSTRAINT "point_batches_source_transaction_id_point_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."point_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_batches" ADD CONSTRAINT "point_batches_ref_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_point_batches_user_expire" ON "point_batches" USING btree ("user_id","expire_at");--> statement-breakpoint
CREATE INDEX "idx_point_batches_ref_order" ON "point_batches" USING btree ("ref_order_id") WHERE ref_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_point_batches_source_txn" ON "point_batches" USING btree ("source_transaction_id");--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "chk_sale_order_points_used" CHECK ("sale_orders"."points_used" >= 0);--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "chk_sale_order_points_discount" CHECK ("sale_orders"."points_discount" >= 0);--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "chk_pt_amount_sign" CHECK (("point_transactions"."amount" < 0 AND "point_transactions"."type" IN ('消费冲销','消费抵扣','过期扣减')) OR "point_transactions"."amount" > 0);
--> statement-breakpoint
INSERT INTO point_batches (
	user_id,
	source_transaction_id,
	source_type,
	ref_order_id,
	original_amount,
	remaining_amount,
	earned_at,
	expire_at,
	created_at,
	updated_at
)
SELECT
	user_id,
	id,
	type,
	ref_order_id,
	amount,
	amount,
	created_at,
	created_at + INTERVAL '365 days',
	NOW(),
	NOW()
FROM point_transactions
WHERE amount > 0;
--> statement-breakpoint
DO $$
DECLARE
	neg RECORD;
	batch RECORD;
	need_to_consume bigint;
	consume_amount bigint;
BEGIN
	FOR neg IN
		SELECT id, user_id, ref_order_id, -amount AS consume_points
		FROM point_transactions
		WHERE amount < 0
		ORDER BY created_at, id
	LOOP
		need_to_consume := neg.consume_points;

		FOR batch IN
			SELECT id, remaining_amount
			FROM point_batches
			WHERE user_id = neg.user_id
			  AND remaining_amount > 0
			ORDER BY
				CASE
					WHEN neg.ref_order_id IS NOT NULL AND ref_order_id = neg.ref_order_id THEN 0
					ELSE 1
				END,
				expire_at,
				id
			FOR UPDATE
		LOOP
			consume_amount := LEAST(batch.remaining_amount, need_to_consume);
			UPDATE point_batches
			   SET remaining_amount = remaining_amount - consume_amount,
			       updated_at = NOW()
			 WHERE id = batch.id;
			need_to_consume := need_to_consume - consume_amount;
			EXIT WHEN need_to_consume <= 0;
		END LOOP;
	END LOOP;
END $$;
--> statement-breakpoint
WITH due AS MATERIALIZED (
	SELECT id, user_id, remaining_amount, expire_at
	FROM point_batches
	WHERE remaining_amount > 0
	  AND expire_at <= NOW()
),
inserted_expiry AS (
	INSERT INTO point_transactions
		(user_id, type, amount, ref_order_id, external_ref, created_at)
	SELECT
		user_id,
		'过期扣减',
		-remaining_amount,
		NULL,
		'points-expire-' || id::text,
		expire_at
	FROM due
	ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
	RETURNING id
)
UPDATE point_batches pb
   SET remaining_amount = 0,
       expired_at = due.expire_at,
       updated_at = NOW()
  FROM due
 WHERE pb.id = due.id;
--> statement-breakpoint
UPDATE client_wechat_users c
   SET points_balance = COALESCE((
         SELECT SUM(pb.remaining_amount)
         FROM point_batches pb
         WHERE pb.user_id = c.user_id
           AND pb.expire_at > NOW()
       ), 0),
       points_updated_at = NOW()
 WHERE COALESCE(c.points_balance, 0) IS DISTINCT FROM COALESCE((
         SELECT SUM(pb.remaining_amount)
         FROM point_batches pb
         WHERE pb.user_id = c.user_id
           AND pb.expire_at > NOW()
       ), 0);
