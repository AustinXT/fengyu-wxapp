-- 9 枚举英文→中文（ALTER TYPE RENAME VALUE 自动更新所有列值）
-- 先例：0002_rename_sale_order_type_values.sql

-- 1. allocation_status
ALTER TYPE "allocation_status" RENAME VALUE 'pending' TO '待分配';
ALTER TYPE "allocation_status" RENAME VALUE 'allocated' TO '已分配';

-- 2. item_direction
ALTER TYPE "item_direction" RENAME VALUE 'purchase' TO '购买';
ALTER TYPE "item_direction" RENAME VALUE 'convert_out' TO '转出';
ALTER TYPE "item_direction" RENAME VALUE 'convert_in' TO '转入';
ALTER TYPE "item_direction" RENAME VALUE 'refund_out' TO '退出';

-- 3. payment_method
ALTER TYPE "payment_method" RENAME VALUE 'wechat' TO '微信';
ALTER TYPE "payment_method" RENAME VALUE 'alipay' TO '支付宝';
ALTER TYPE "payment_method" RENAME VALUE 'offline' TO '线下';

-- 4. store_unbind_request_status
ALTER TYPE "store_unbind_request_status" RENAME VALUE 'pending' TO '待处理';
ALTER TYPE "store_unbind_request_status" RENAME VALUE 'approved' TO '已通过';
ALTER TYPE "store_unbind_request_status" RENAME VALUE 'rejected' TO '已拒绝';
ALTER TYPE "store_unbind_request_status" RENAME VALUE 'cancelled' TO '已取消';

-- 5. org_node_type
ALTER TYPE "org_node_type" RENAME VALUE 'headquarters' TO '总部';
ALTER TYPE "org_node_type" RENAME VALUE 'market' TO '市场';
ALTER TYPE "org_node_type" RENAME VALUE 'store' TO '门店';
ALTER TYPE "org_node_type" RENAME VALUE 'department' TO '部门';

-- 6. point_transaction_type
ALTER TYPE "point_transaction_type" RENAME VALUE 'earn' TO '获取';
ALTER TYPE "point_transaction_type" RENAME VALUE 'redeem' TO '兑换';

-- 7. message_recipient_type
ALTER TYPE "message_recipient_type" RENAME VALUE 'client' TO '客户';
ALTER TYPE "message_recipient_type" RENAME VALUE 'staff' TO '员工';

-- 8. card_transaction_type
ALTER TYPE "card_transaction_type" RENAME VALUE 'topup' TO '充值';
ALTER TYPE "card_transaction_type" RENAME VALUE 'deduct' TO '扣款';

-- 9. position_scope
ALTER TYPE "position_scope" RENAME VALUE 'headquarters' TO '总部';
ALTER TYPE "position_scope" RENAME VALUE 'market' TO '市场';
ALTER TYPE "position_scope" RENAME VALUE 'store' TO '门店';
