const fail = (message) => {
  throw new Error("INVALID_PARAMS: " + message);
};
function today() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function date(value = today()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail("日期格式应为 YYYY-MM-DD");
  const parsed = new Date(value + "T00:00:00Z");
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value > today()
  )
    fail("不能选择无效日期或未来日期");
  return value;
}
function text(value, max) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max)
    fail("内容格式错误或超过字数限制");
  return value.trim();
}
function body(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    fail("参数格式错误");
  const reportDate = date(payload.date);
  if (!Number.isInteger(payload.version) || payload.version < 0)
    fail("缺少有效版本，请重新加载");
  if (!Array.isArray(payload.entries) || payload.entries.length > 500)
    fail("业务条目格式错误");
  const seen = new Set();
  const entries = payload.entries.map((e) => {
    if (
      !e ||
      !["service", "sale"].includes(e.businessType) ||
      typeof e.businessId !== "string" ||
      !e.businessId ||
      e.businessId.length > 100
    )
      fail("业务条目不合法");
    const key = e.businessType + ":" + e.businessId;
    if (seen.has(key)) fail("业务条目重复");
    seen.add(key);
    return {
      businessType: e.businessType,
      businessId: e.businessId,
      feedback: text(e.feedback, 300),
      followUp: text(e.followUp, 300),
    };
  });
  return {
    reportDate,
    version: payload.version,
    entries,
    action: text(payload.action, 500),
    growth: text(payload.growth, 500),
    plan: text(payload.plan, 500),
  };
}
module.exports = { today, date, text, body };
