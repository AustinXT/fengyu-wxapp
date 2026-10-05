const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyTestCode, testIdentity } = require("../utils/test-binding");
const code = "abcdef0123456789abcdef01";
const config = {
  hash: crypto.createHash("sha256").update(code).digest("hex"),
  employeeId: "TEST-EMP",
  expiresAt: 2000,
};
const env = {
  DEPLOY_CHANNEL: "shadow",
  PG_CONNECTION_STRING: "postgres://test:test@101.34.242.103:8151/fengyu_daily_dev",
};
test("测试码服务端确定员工编号，不接受客户端选择员工", () => {
  assert.equal(
    verifyTestCode({ code, employeeId: "FORGED" }, config, env, 1000),
    "TEST-EMP",
  );
});
test("绑定码可并存，临时选择目标员工且不改变真实微信身份", () => {
  const secondCode = "0123456789abcdef01234567";
  const entries = [config, {
    hash: crypto.createHash("sha256").update(secondCode).digest("hex"),
    employeeId: "TEST-MANAGER",
    expiresAt: 2000,
  }];
  const real = { appid: "wx4da3e1e9ad861396", openid: "REAL-WX-ID" };
  const first = testIdentity(real, { code }, entries, env, 1000);
  const second = testIdentity(real, { code: secondCode }, entries, env, 1000);
  assert.equal(first.employeeId, "TEST-EMP");
  assert.equal(second.employeeId, "TEST-MANAGER");
  assert.deepEqual(first.identity, real);
  assert.deepEqual(second.identity, real);
});
test("长期测试绑定码不会过期，且仍只临时切换服务端测试身份", () => {
  const permanentCode = "fedcba9876543210fedcba98";
  const permanent = {
    hash: crypto.createHash("sha256").update(permanentCode).digest("hex"),
    employeeId: "FY-260914002",
    expiresAt: null,
  };
  const real = { appid: "wx4da3e1e9ad861396", openid: "REAL-WX-ID" };
  assert.equal(
    verifyTestCode({ code: permanentCode }, permanent, env, Number.MAX_SAFE_INTEGER),
    "FY-260914002",
  );
  const switched = testIdentity(real, { code: permanentCode }, permanent, env, Number.MAX_SAFE_INTEGER);
  assert.equal(switched.employeeId, "FY-260914002");
  assert.deepEqual(switched.identity, real);
  assert.throws(() => verifyTestCode({ code: permanentCode }, { ...permanent, expiresAt: undefined }, env), /PERMISSION_DENIED/);
});
test("拒绝错误、过期、未配置绑定码和直接手机号", () => {
  assert.throws(
    () => verifyTestCode({ code: "0".repeat(24) }, config, env, 1000),
    /PERMISSION_DENIED/,
  );
  assert.throws(
    () => verifyTestCode({ code }, config, env, 2000),
    /INVALID_STATE/,
  );
  assert.throws(
    () => verifyTestCode({ code }, null, env, 1000),
    /INVALID_STATE/,
  );
  assert.throws(
    () => verifyTestCode({ phone: "13800000000" }, config, env, 1000),
    /INVALID_PARAMS/,
  );
});
test("正式通道、生产库、连接覆盖参数均不能使用测试绑定", () => {
  for (const bad of [
    { ...env, DEPLOY_CHANNEL: "primary" },
    {
      ...env,
      PG_CONNECTION_STRING:
        "postgres://test:test@118.178.196.26:5432/fengyu_wxapp",
    },
    { ...env, PG_CONNECTION_STRING: env.PG_CONNECTION_STRING + "?host=other" },
    { ...env, PG_CONNECTION_STRING: "postgres://test:test@101.34.242.103:5433/fengyu_wxapp" },
    {},
  ])
    assert.throws(
      () => verifyTestCode({ code }, config, bad, 1000),
      /PERMISSION_DENIED/,
    );
});
