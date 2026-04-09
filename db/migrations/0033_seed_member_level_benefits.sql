-- 种子：会员等级升级权益配置（占位值，实际数额由业务方在 admin /settings 中调整）
--
-- 配置格式：JSON 字符串，每个等级对应：
--   points              升级时奖励积分（整数）
--   couponTemplateIds   升级时发放的优惠券模板 ID 数组（需先在 coupon_templates 中创建）
--   messageTitle        升级消息标题
--   messageBody         升级消息正文
--
-- cronTask 在每日凌晨3点扫描会员等级变化，对升级用户调用 grantUpgradeBenefits()
-- 派发"消息 + 积分 + 优惠券"三件套权益。降级仅记录 operation_logs，不发权益。

INSERT INTO system_configs (key, value, updated_at)
VALUES (
  'member_level_benefits',
  $${
    "初钻": {
      "points": 100,
      "couponTemplateIds": [],
      "messageTitle": "🎉 恭喜成为初钻会员",
      "messageBody": "您已达到初钻会员标准，享受会员专属服务。"
    },
    "星钻": {
      "points": 500,
      "couponTemplateIds": [],
      "messageTitle": "🎉 恭喜升级为星钻会员",
      "messageBody": "您已晋升至星钻会员，专属权益已为您解锁。"
    },
    "粉钻": {
      "points": 1000,
      "couponTemplateIds": [],
      "messageTitle": "🎉 恭喜升级为粉钻会员",
      "messageBody": "粉钻会员尊享权益已解锁，期待为您服务。"
    },
    "金钻": {
      "points": 3000,
      "couponTemplateIds": [],
      "messageTitle": "🎉 恭喜升级为金钻会员",
      "messageBody": "金钻顶级权益已解锁，感谢您的长期信赖。"
    },
    "黑钻": {
      "points": 10000,
      "couponTemplateIds": [],
      "messageTitle": "🎉 恭喜升级为黑钻会员",
      "messageBody": "黑钻至尊会员，专属管家服务已为您启用。"
    }
  }$$,
  NOW()
)
ON CONFLICT (key) DO NOTHING;
