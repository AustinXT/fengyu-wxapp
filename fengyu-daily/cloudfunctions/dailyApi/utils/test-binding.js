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
  const entries = Array.isArray(config) ? config : config ? [config] : [];
  if (!entries.length)
    throw Error("INVALID_STATE: 测试绑定码未配置或已过期，请联系管理员");
  const hash = crypto.createHash("sha256").update(code).digest();
  for (const entry of entries) {
    if (
      !/^[a-f0-9]{64}$/.test(entry?.hash || "") ||
      typeof entry.employeeId !== "string" ||
      (entry.expiresAt !== null && !Number.isFinite(entry.expiresAt))
    ) continue;
    if (crypto.timingSafeEqual(hash, Buffer.from(entry.hash, "hex"))) {
      if (entry.expiresAt !== null && entry.expiresAt <= now)
        throw Error("INVALID_STATE: 测试绑定码未配置或已过期，请联系管理员");
      return entry.employeeId;
    }
  }
  throw Error("PERMISSION_DENIED: 测试绑定码不正确或已过期");
}
function testIdentity(identity, payload, config, env = process.env, now = Date.now()) {
  const employeeId = verifyTestCode(payload, config, env, now);
  return { identity, employeeId };
}
module.exports = { verifyTestCode, testIdentity };
