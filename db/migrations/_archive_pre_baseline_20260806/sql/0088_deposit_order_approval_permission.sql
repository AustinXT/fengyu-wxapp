-- 为寄存单审批追加 admin 端权限动作。
-- 运行时权限矩阵以 system_configs.permission_matrix 为准；已有环境需要幂等补齐。

DO $$
DECLARE
  matrix jsonb;
  role_name text;
  action_name text := 'sale_order:deposit_approve';
BEGIN
  SELECT value::jsonb
    INTO matrix
    FROM system_configs
   WHERE key = 'permission_matrix'
   FOR UPDATE;

  IF matrix IS NULL THEN
    RETURN;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['admin', 'manager', 'finance'] LOOP
    IF NOT (COALESCE(matrix -> role_name, '[]'::jsonb) ? action_name) THEN
      matrix := jsonb_set(
        matrix,
        ARRAY[role_name],
        COALESCE(matrix -> role_name, '[]'::jsonb) || to_jsonb(action_name),
        true
      );
    END IF;
  END LOOP;

  UPDATE system_configs
     SET value = matrix::text,
         updated_at = NOW()
   WHERE key = 'permission_matrix';
END $$;
