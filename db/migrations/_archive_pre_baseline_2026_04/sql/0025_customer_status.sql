-- client_wechat_users: 添加到店状态字段
-- 基于已完成服务单历史自动计算，每日凌晨3点更新
-- 保有会员-稳定: 90天内至少到店1次，且累计到店>=6次
-- 保有会员-有效: 90天内至少到店1次，且累计到店<=5次
-- 预警沉睡: 超过3个月未到店，至6个月
-- 冰冻: 超过6个月未到店，至12个月
-- 休眠: 超过12个月未到店 / 从未到店
CREATE TYPE customer_status AS ENUM ('保有会员-稳定', '保有会员-有效', '预警沉睡', '冰冻', '休眠');
ALTER TABLE client_wechat_users ADD COLUMN customer_status customer_status NOT NULL DEFAULT '休眠';
