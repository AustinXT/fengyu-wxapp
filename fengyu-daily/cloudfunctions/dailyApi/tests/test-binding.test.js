const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyTestCode } = require("../utils/test-binding");
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

test("绑定事务拒绝重复使用，不覆盖任何原有微信身份", async () => {
  const { consumeTestBinding } = require("../utils/test-binding");
  const queries = [];
  const pg = {
    transaction: async (fn) =>
      fn({
        query: async (sql, values) => {
          queries.push({ sql, values });
          return {
            rows: queries.length === 1 ? [{ employee_id: "TEST-EMP" }] : [{}],
          };
        },
      }),
  };
  await assert.rejects(
    consumeTestBinding(
      pg,
      { appid: "wx4da3e1e9ad861396", openid: "TEST-WX" },
      "TEST-EMP",
    ),
    /CONFLICT:/,
  );
  assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes("FOR UPDATE"));
  assert.ok(queries[1].sql.includes("$3"));
});
