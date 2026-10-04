const crypto = require("node:crypto");
function verifyTestCode(payload, config, env = process.env, now = Date.now()) {
  let url;
  try {
    url = new URL(env.PG_CONNECTION_STRING);
  } catch (_) {}
  if (
    env.DEPLOY_CHANNEL !== "shadow" ||
    !url ||
    url.hostname !== "101.34.242.103" ||
    url.port !== "8151" ||
    url.pathname !== "/fengyu_daily_dev" ||
    url.search
  )
    throw Error("PERMISSION_DENIED: 测试绑定仅限日报开发库");
  const code = payload?.code;
  if (typeof code !== "string" || !/^[a-f0-9]{24}$/.test(code))
    throw Error("INVALID_PARAMS: 请输入有效的测试绑定码");
  if (
    !config ||
    !/^[a-f0-9]{64}$/.test(config.hash || "") ||
    typeof config.employeeId !== "string" ||
    !Number.isFinite(config.expiresAt) ||
    config.expiresAt <= now
  )
    throw Error("INVALID_STATE: 测试绑定码未配置或已过期，请联系管理员");
  const hash = crypto.createHash("sha256").update(code).digest();
  if (!crypto.timingSafeEqual(hash, Buffer.from(config.hash, "hex")))
    throw Error("PERMISSION_DENIED: 测试绑定码不正确");
  return config.employeeId;
}
async function consumeTestBinding(pg, identity, employeeId) {
  await pg
    .transaction(async (client) => {
      const { rows: employees } = await client.query(
        "SELECT employee_id FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false FOR UPDATE",
        [employeeId],
      );
      if (employees.length !== 1)
        throw Error("PERMISSION_DENIED: 测试员工不可用");
      const { rows: existing } = await client.query(
        "SELECT 1 FROM daily_wechat_bindings WHERE appid=$1 AND (employee_id=$2 OR openid=$3) FOR UPDATE",
        [identity.appid, employeeId, identity.openid],
      );
      if (existing.length)
        throw Error("CONFLICT: 绑定码已使用或当前微信已绑定，请重新加载首页");
      await client.query(
        "INSERT INTO daily_wechat_bindings(appid,openid,employee_id) VALUES($1,$2,$3)",
        [identity.appid, identity.openid, employeeId],
      );
    })
    .catch((e) => {
      if (e.code === "23505") throw Error("CONFLICT: 绑定码已使用或微信已绑定");
      throw e;
    });
}
module.exports = { verifyTestCode, consumeTestBinding };
