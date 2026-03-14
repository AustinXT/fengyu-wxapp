-- 添加订单备注字段（员工端开单时填写）
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS remark text;

-- 退款专用字段（P2 退款功能预留）
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS handling_fee numeric(10, 2);
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS approved_by varchar(30) REFERENCES staff_wechat_users(employee_id);
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS approved_at timestamp;
ALTER TABLE sale_orders ADD COLUMN IF NOT EXISTS rejected_reason text;
