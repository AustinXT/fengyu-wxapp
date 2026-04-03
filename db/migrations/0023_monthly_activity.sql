-- client_wechat_users: 添加月度客活字段
-- 每日凌晨3点根据当月已完成服务单计算
-- 二次客活：当月到店（服务单完成）>= 2 次（按天去重）
-- 一次客活：当月到店 = 1 次
-- 0次客活：保有会员（会员客）中当月未到店
CREATE TYPE monthly_activity AS ENUM ('二次客活', '一次客活', '0次客活');
ALTER TABLE client_wechat_users ADD COLUMN monthly_activity monthly_activity;

-- client_wechat_users: 添加到店状态字段
-- 每日凌晨3点根据服务单历史计算（仅会员客）
-- 保有会员-稳定：3个月内至少到店1次，且累计到店 >= 6 次
-- 保有会员-有效：3个月内至少到店1次，但累计到店 <= 5 次
-- 预警沉睡：超过3个月未到店，至6个月
-- 冰冻：超过6个月未到店，至12个月
-- 休眠：超过12个月未到店（或从未到店）
CREATE TYPE customer_status AS ENUM ('保有会员-稳定', '保有会员-有效', '预警沉睡', '冰冻', '休眠');
ALTER TABLE client_wechat_users ADD COLUMN customer_status customer_status;
