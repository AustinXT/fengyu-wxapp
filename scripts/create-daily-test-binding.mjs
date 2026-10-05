import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ROOT, devConnection } from "./daily-dev-config.mjs";
const require = createRequire(import.meta.url);
const {
  Client,
} = require("../fengyu-daily/cloudfunctions/dailyApi/node_modules/pg");
const targetArg = process.argv[2];
if (!targetArg) throw Error("需要指定测试员工编号或手机号");
const byEmployeeId = /^DLYTEST_[A-Z0-9_]+$/.test(targetArg) || targetArg === "FY-260914002";
if (!byEmployeeId && !/^1\d{10}$/.test(targetArg))
  throw Error("仅支持 DLYTEST_* 测试员工、周智慧测试身份 FY-260914002，或员工手机号");
const client = new Client({ connectionString: devConnection() });
try {
  await client.connect();
  const { rows } = await client.query(
    byEmployeeId
      ? "SELECT employee_id FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false"
      : "SELECT employee_id FROM staff_wechat_users WHERE phone=$1 AND is_resigned=false",
    [targetArg],
  );
  if (rows.length !== 1) throw Error("手机号必须匹配唯一在职员工");
  const { rows: bound } = await client.query(
    "SELECT 1 FROM daily_wechat_bindings WHERE appid=$1 AND employee_id=$2",
    ["wx4da3e1e9ad861396", rows[0].employee_id],
  );
  if (bound.length && !byEmployeeId) throw Error("该员工已绑定日报微信，请使用已绑定微信测试");
  const code = crypto.randomBytes(12).toString("hex");
  const entry = {
    hash: crypto.createHash("sha256").update(code).digest("hex"),
    employeeId: rows[0].employee_id,
    expiresAt: null,
  };
  const target = path.join(
    ROOT,
    "fengyu-daily/cloudfunctions/dailyApi/utils/test-binding.json",
  );
  let entries = [];
  try {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    entries = (Array.isArray(existing) ? existing : [existing])
      .filter((item) => (item?.expiresAt === null || item?.expiresAt > Date.now()) && item.employeeId !== entry.employeeId);
  } catch (_) {}
  entries.push(entry);
  fs.writeFileSync(target, JSON.stringify(entries), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  const output = path.join(ROOT, `_tmp/daily-deploy/test-binding-code-${rows[0].employee_id}.txt`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, code, { mode: 0o600 });
  console.log(
    `已生成长期有效的日报开发测试码（${rows[0].employee_id}）；仅写入本地忽略文件，未修改微信绑定或数据库。`,
  );
} finally {
  await client.end();
}
