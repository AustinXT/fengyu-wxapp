const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const v = require("../utils/validation");
const auth = require("../routes/auth");
const { buildErrorResponse } = require("../utils/error-codes");
test("拒绝未来日期、无效自然日和非法版本", () => {
  for (const d of ["2026-02-30", "2099-01-01", "2026/01/01", null])
    assert.throws(() => v.date(d), /INVALID_PARAMS/);
  assert.throws(
    () => v.body({ date: v.today(), version: -1, entries: [] }),
    /INVALID_PARAMS/,
  );
});
test("反馈长度和重复条目校验", () => {
  assert.throws(
    () =>
      v.body({
        version: 0,
        entries: [
          { businessType: "sale", businessId: "1", feedback: "a".repeat(301) },
        ],
      }),
    /INVALID_PARAMS/,
  );
  assert.throws(
    () =>
      v.body({
        version: 0,
        entries: [
          { businessType: "sale", businessId: "1" },
          { businessType: "sale", businessId: "1" },
        ],
      }),
    /重复/,
  );
});
test("微信上下文必须来自日报 AppID", async () => {
  await assert.rejects(
    () => auth.identity({ APPID: "staff-app", OPENID: "x" }),
    /UNAUTHORIZED/,
  );
  await assert.rejects(
    () => auth.identity({ APPID: "wx4da3e1e9ad861396" }),
    /UNAUTHORIZED/,
  );
});
test("PHONE_REQUIRED 和权限拒绝通过 errorType 区分", () => {
  const a = buildErrorResponse(new Error("PHONE_REQUIRED: 需绑定")),
    b = buildErrorResponse(new Error("PERMISSION_DENIED: 无权"));
  assert.equal(a.code, b.code);
  assert.notEqual(a.errorType, b.errorType);
  assert.equal(
    buildErrorResponse(new Error("postgres://secret")).message,
    "服务器内部错误",
  );
});
test("员工端工具独立副本保持一致", () => {
  for (const file of ["db/pg.js", "utils/error-codes.js", "utils/scope.js", "utils/permission-matrix.js"]) {
    assert.equal(
      fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      fs.readFileSync(
        path.join(
          __dirname,
          "../../../../fengyu-staff/cloudfunctions/staffApi",
          file,
        ),
        "utf8",
      ),
    );
  }
});
