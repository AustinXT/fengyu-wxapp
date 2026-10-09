ALTER TABLE sale_items ADD COLUMN conversion_value_snapshot jsonb;

CREATE TABLE conversion_point_transfers (
 id bigserial PRIMARY KEY,
 user_id text NOT NULL REFERENCES client_wechat_users(user_id),
 from_order_id varchar(30) NOT NULL REFERENCES sale_orders(sale_order_id),
 to_order_id varchar(30) NOT NULL REFERENCES sale_orders(sale_order_id),
 from_sale_item_id varchar(30) NOT NULL REFERENCES sale_items(sale_item_id),
 excluded_basis_cents bigint NOT NULL,
 transferred_points bigint NOT NULL,
 batch_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT chk_conversion_point_transfer_nonnegative CHECK(excluded_basis_cents >= 0 AND transferred_points >= 0),
 CONSTRAINT chk_conversion_point_transfer_different_orders CHECK(from_order_id <> to_order_id)
);
CREATE UNIQUE INDEX uq_conversion_point_transfer_item ON conversion_point_transfers(to_order_id,from_sale_item_id);
CREATE INDEX idx_conversion_point_transfer_from ON conversion_point_transfers(from_order_id);
CREATE INDEX idx_conversion_point_transfer_to ON conversion_point_transfers(to_order_id);
