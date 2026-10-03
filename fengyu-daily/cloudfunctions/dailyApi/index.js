const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const auth = require("./routes/auth");
const { buildErrorResponse } = require("./utils/error-codes");
const routes = {
  "auth.login": ["auth", "login"],
  "auth.bindPhone": ["auth", "bindPhone"],
  "auth.bindTestCode": ["auth", "bindTestCode"],
  "report.status": ["report", "status"],
  "report.read": ["report", "read"],
  "report.save": ["report", "save"],
  "report.submit": ["report", "submit"],
  "report.history": ["report", "history"],
  "report.previous": ["report", "previous"],
  "pk.classes": ["pk", "classes"],
  "pk.read": ["pk", "read"],
  "period.list": ["period", "list"],
  "target.read": ["target", "read"],
  "target.confirmMonth": ["target", "confirmMonth"],
  "target.saveWeek": ["target", "saveWeek"],
  "metrics.read": ["metrics", "read"],
  "contacts.list": ["contacts", "list"],
  "business.list": ["business", "list"],
  "manager.list": ["manager", "list"],
  "manager.detail": ["manager", "detail"],
  "management.read": ["management", "read"],
};
exports.main = async (event) => {
  try {
    const route = routes[event?.action];
    if (!route) throw new Error("INVALID_PARAMS: 不支持的操作");
    const identity = await auth.identity(cloud.getWXContext());
    if (!process.env.PG_CONNECTION_STRING?.trim())
      throw new Error("INVALID_STATE: 日报服务尚未配置数据库连接，请联系管理员完成云函数配置。");
    const ctx = { event, identity, cloud, auth: null, result: null };
    if (route[0] !== "auth") ctx.auth = await auth.requireUser(identity);
    await require("./routes/" + route[0])[route[1]](ctx);
    return { code: 0, message: "success", data: ctx.result };
  } catch (e) {
    // 不输出请求体、手机号、OPENID、数据库连接串。
    console.error("dailyApi failed", {
      code: e.code || null,
      type: e.message?.split(":")[0],
    });
    return buildErrorResponse(e);
  }
};
