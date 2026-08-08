ALTER TABLE "client_wechat_users" RENAME COLUMN "promoter_employee_id" TO "promoter_employee_name";--> statement-breakpoint
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint AS c
    JOIN pg_attribute AS a
      ON a.attrelid = c.conrelid
      AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.client_wechat_users'::regclass
      AND c.contype = 'f'
      AND a.attname = 'promoter_employee_name'
  LOOP
    EXECUTE format('ALTER TABLE public.client_wechat_users DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "client_wechat_users" ALTER COLUMN "promoter_employee_name" SET DATA TYPE varchar(50);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "client_wechat_users" AS c
    LEFT JOIN "staff_wechat_users" AS s ON s."employee_id" = c."promoter_employee_name"
    WHERE c."promoter_employee_name" IS NOT NULL
      AND (s."employee_id" IS NULL OR NULLIF(btrim(s."name"), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'client_wechat_users contains promoter IDs without a resolvable staff name';
  END IF;
END $$;--> statement-breakpoint
UPDATE "client_wechat_users" AS c
SET "promoter_employee_name" = s."name"
FROM "staff_wechat_users" AS s
WHERE c."promoter_employee_name" = s."employee_id";
