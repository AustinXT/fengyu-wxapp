-- client_wechat_users: 添加顾客类型字段
-- 流量客：仅注册账户，未进行任何消费
-- 体验客：售前体验卡68/99/线上体验等（体验单）
-- 小美客：单笔消费 < 1990 元（普通单）
-- 会员客：单笔消费 >= 1990 元（普通单，含订单款清达标）
CREATE TYPE customer_type AS ENUM ('流量客', '体验客', '小美客', '会员客');
ALTER TABLE client_wechat_users ADD COLUMN customer_type customer_type NOT NULL DEFAULT '流量客';

-- client_wechat_users: 添加历史消费档位字段
-- 按顾客历史累计消费金额分档，≥1990 为被经营顾客，<1990 为未被经营顾客
CREATE TYPE spending_tier AS ENUM ('10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990');
ALTER TABLE client_wechat_users ADD COLUMN spending_tier spending_tier NOT NULL DEFAULT '<1990';
