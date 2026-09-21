-- #187 判据层验证：最小 schema + 正负例数据
CREATE TYPE customer_type AS ENUM ('流量客', '体验客', '小美客', '会员客');
CREATE TYPE member_level AS ENUM ('初钻', '星钻', '粉钻', '金钻', '黑钻');
CREATE TYPE document_type AS ENUM ('售前一次', '售前二次', '售后');

CREATE TABLE client_wechat_users (
  user_id text PRIMARY KEY,
  customer_type customer_type NOT NULL DEFAULT '流量客',
  member_level member_level,
  became_member_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE sale_orders (
  sale_order_id text PRIMARY KEY,
  client_user_id text,
  status text NOT NULL,
  sale_order_type text NOT NULL,
  total_amount numeric(10,2) NOT NULL DEFAULT 0,
  -- I1 不变量：received = Σ sop[已支付, 首次支付/回款/储值卡抵扣]，**不含退款**（退款记 refunded_amount）
  received numeric(10,2) NOT NULL DEFAULT 0,
  refunded_amount numeric(10,2) NOT NULL DEFAULT 0,
  is_membership_upgrade boolean NOT NULL DEFAULT false,
  document_type document_type,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sale_items (
  sale_item_id text PRIMARY KEY,
  updated_at timestamptz DEFAULT now(),
  sale_order_id text NOT NULL REFERENCES sale_orders(sale_order_id),
  item_direction text NOT NULL DEFAULT '购买',
  sale_amount numeric(10,2) NOT NULL DEFAULT 0,
  received numeric(10,2) NOT NULL DEFAULT 0,
  is_experience boolean NOT NULL DEFAULT false
);

CREATE TABLE sale_order_payments (
  id bigserial PRIMARY KEY,
  sale_order_id text NOT NULL REFERENCES sale_orders(sale_order_id),
  change_type text NOT NULL,
  status text NOT NULL,
  amount numeric(10,2) NOT NULL DEFAULT 0,
  note text
);

-- ============ 正负例数据 ============
INSERT INTO client_wechat_users (user_id) VALUES
  ('U_mix'),        -- 混合订单：体验 500 + 非体验 1600 = 2100
  ('U_pure'),       -- 纯非体验 2000 ≥ 1980
  ('U_trial'),      -- 只买体验卡 680
  ('U_small'),      -- 非体验 500 < 1980
  ('U_refund'),     -- 非体验 2000 付清后退 1500（毛实收应仍 2000）
  ('U_partial'),    -- 部分支付订单（未结清）
  ('U_none'),       -- 无订单
  ('U_zero'),       -- 已结清但 received=0
  ('U_legacy'),     -- WorkFine 历史单：无 sale_items 行
  ('U_overrefund'), -- 退款 note 额度 > 该行实际扣减额
  ('U_badjson');    -- note 以 { 开头但非合法 JSON

INSERT INTO sale_orders (sale_order_id, client_user_id, status, sale_order_type, total_amount, received, paid_at, created_at) VALUES
  ('O_mix',    'U_mix',       '已支付','销售单',2100,2100,'2026-01-10','2026-01-10'),
  ('O_pure',   'U_pure',      '已支付','销售单',2000,2000,'2026-01-11','2026-01-11'),
  ('O_trial',  'U_trial',     '已支付','销售单', 680, 680,'2026-01-12','2026-01-12'),
  ('O_small',  'U_small',     '已支付','销售单', 500, 500,'2026-01-13','2026-01-13'),
  ('O_refund', 'U_refund',    '已支付','销售单',2000,2000,'2026-01-14','2026-01-14'),
  ('O_partial','U_partial',   '部分支付','销售单',5000,2500,NULL,'2026-01-15'),
  ('O_zero',   'U_zero',      '已支付','销售单',   0,   0,'2026-01-16','2026-01-16'),
  ('O_legacy', 'U_legacy',    '已支付','销售单',3000,3000,'2025-06-01','2025-06-01'),
  ('O_over',   'U_overrefund','已支付','销售单', 500, 500,'2026-02-01','2026-02-01'),
  ('O_bad',    'U_badjson',   '已支付','销售单',2500,2500,'2026-03-01','2026-03-01');

UPDATE sale_orders SET refunded_amount = 1500 WHERE sale_order_id = 'O_refund';
UPDATE sale_orders SET refunded_amount =  500 WHERE sale_order_id = 'O_over';

INSERT INTO sale_items (sale_item_id, sale_order_id, item_direction, sale_amount, received, is_experience) VALUES
  ('I_mix_t',  'O_mix',    '购买', 500, 500, true),
  ('I_mix_n',  'O_mix',    '购买',1600,1600, false),
  ('I_pure',   'O_pure',   '购买',2000,2000, false),
  ('I_trial',  'O_trial',  '购买', 680, 680, true),
  ('I_small',  'O_small',  '购买', 500, 500, false),
  -- 付清 2000 后退 1500 → 行级 received 净额 500，毛实收应还原为 2000
  ('I_refund', 'O_refund', '购买',2000, 500, false),
  ('I_partial','O_partial','购买',5000,2500, false),
  ('I_zero',   'O_zero',   '购买',   0,   0, false),
  -- 退款 note 记 9999 但该行毛额只有 500 → LEAST 封顶后应为 500，不得高估
  ('I_over',   'O_over',   '购买', 500,   0, false),
  ('I_bad',    'O_bad',    '购买',2500,2500, false);
-- O_legacy 故意不建 sale_items 行（WorkFine 历史单形态）

INSERT INTO sale_order_payments (sale_order_id, change_type, status, amount, note) VALUES
  ('O_refund','退款','已支付',-1500,'{"items":[{"refSaleItemId":"I_refund","refundAmount":1500}]}'),
  -- 脏数据守护：note 非 JSON → try_jsonb 返回 NULL
  ('O_pure',  '退款','已支付',   -1,'手工备注不是 JSON'),
  -- 已作废退款流水 → WHERE status 挡掉（若漏挡 U_pure 会变成 2999）
  ('O_pure',  '退款','已作废', -999,'{"items":[{"refSaleItemId":"I_pure","refundAmount":999}]}'),
  -- items 非数组 → jsonb_typeof 兜住
  ('O_mix',   '退款','已支付',   -1,'{"items":"不是数组"}'),
  -- 超额 refundAmount → LEAST 封顶
  ('O_over',  '退款','已支付', -500,'{"items":[{"refSaleItemId":"I_over","refundAmount":9999}]}'),
  -- 以 { 开头但非合法 JSON → 旧写法的 ::jsonb 会抛 22P02，靠 try_jsonb 降级兜住
  ('O_bad',   '退款','已支付',   -1,'{手工备注不是合法JSON}');

-- ===== 闸门 2 追加：GLM P1 场景 =====
-- 只含「退出」方向明细的销售单：COUNT(购买行)=0 但订单确实有明细行。
-- 旧写法会误走回退分支、用订单级 received 3000 且绕过 LEAST 封顶 → 误升会员客。
INSERT INTO client_wechat_users (user_id) VALUES ('U_exitonly');
INSERT INTO sale_orders (sale_order_id, client_user_id, status, sale_order_type, total_amount, received, paid_at, created_at)
VALUES ('O_exit','U_exitonly','已支付','销售单',3000,3000,'2026-04-01','2026-04-01');
INSERT INTO sale_items (sale_item_id, sale_order_id, item_direction, sale_amount, received, is_experience)
VALUES ('I_exit','O_exit','退出',3000,0,false);

-- ===== 闸门 2 round-4 追加：跨单错配（codex P1）=====
-- 同一顾客两张单；订单 A 的退款 note 错写了订单 B 的 sale_item_id。
-- 旧写法（退款只按 sale_item_id 聚合+JOIN）会把这笔退款加到 B 的毛实收 → B 被推到 sale_amount 满额 → 误升。
INSERT INTO client_wechat_users (user_id) VALUES ('U_xorder');
INSERT INTO sale_orders (sale_order_id, client_user_id, status, sale_order_type, total_amount, received, paid_at, created_at) VALUES
  ('O_xa','U_xorder','已支付','销售单',100,100,'2026-07-01','2026-07-01'),
  ('O_xb','U_xorder','已支付','销售单',2500,2500,'2026-07-02','2026-07-02');
INSERT INTO sale_items (sale_item_id, sale_order_id, item_direction, sale_amount, received, is_experience) VALUES
  ('I_xa','O_xa','购买',100,100,false),
  -- B 的行已退到只剩 100（净额），若把 A 的退款错加进来会被推回 2500 满额
  ('I_xb','O_xb','购买',2500,100,false);
-- 退款流水挂在订单 A 上，却写了 B 的 item id
INSERT INTO sale_order_payments (sale_order_id, change_type, status, amount, note) VALUES
  ('O_xa','退款','已支付',-2400,'{"items":[{"refSaleItemId":"I_xb","refundAmount":2400}]}');

-- ===== try_jsonb / try_numeric 边界（旧写法必抛 22P02）=====
INSERT INTO client_wechat_users (user_id) VALUES ('U_truncjson'), ('U_badnum');
INSERT INTO sale_orders (sale_order_id, client_user_id, status, sale_order_type, total_amount, received, paid_at, created_at) VALUES
  ('O_trunc','U_truncjson','已支付','销售单',2500,2500,'2026-05-01','2026-05-01'),
  ('O_badnum','U_badnum','已支付','销售单',2500,2500,'2026-05-02','2026-05-02');
INSERT INTO sale_items (sale_item_id, sale_order_id, item_direction, sale_amount, received, is_experience) VALUES
  ('I_trunc','O_trunc','购买',2500,2500,false),
  ('I_badnum','O_badnum','购买',2500,2500,false);
INSERT INTO sale_order_payments (sale_order_id, change_type, status, amount, note) VALUES
  -- 截断 JSON：LIKE '{"%' 守门会放行，裸 ::jsonb 抛 22P02
  ('O_trunc','退款','已支付',-1,'{"items":'),
  -- refundAmount 非数字：裸 ::numeric 抛 22P02
  ('O_badnum','退款','已支付',-1,'{"items":[{"refSaleItemId":"I_badnum","refundAmount":"abc"}]}');
