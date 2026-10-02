import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ROOT, devConnection } from "./daily-dev-config.mjs";
const require = createRequire(import.meta.url);
const {
  Client,
} = require("../fengyu-daily/cloudfunctions/dailyApi/node_modules/pg");
const phone = process.argv[2];
if (!/^1\d{10}$/.test(phone || "")) throw Error("需要指定员工手机号");
const client = new Client({ connectionString: devConnection() });
try {
  await client.connect();
  const { rows } = await client.query(
    "SELECT employee_id FROM staff_wechat_users WHERE phone=$1 AND is_resigned=false",
    [phone],
  );
  if (rows.length !== 1) throw Error("手机号必须匹配唯一在职员工");
  const { rows: bound } = await client.query(
    "SELECT 1 FROM daily_wechat_bindings WHERE appid=$1 AND employee_id=$2",
    ["wx4da3e1e9ad861396", rows[0].employee_id],
  );
  if (bound.length) throw Error("该员工已绑定日报微信，请使用已绑定微信测试");
  const code = crypto.randomBytes(12).toString("hex");
  const config = {
    hash: crypto.createHash("sha256").update(code).digest("hex"),
    employeeId: rows[0].employee_id,
    expiresAt: Date.now() + 4 * 3600000,
  };
  const target = path.join(
    ROOT,
    "fengyu-daily/cloudfunctions/dailyApi/utils/test-binding.json",
  );
  fs.writeFileSync(target, JSON.stringify(config), { mode: 0o600 });
  const output = path.join(ROOT, "_tmp/daily-deploy/test-binding-code.txt");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, code, { mode: 0o600 });
  console.log(
    "已生成4小时有效的测试绑定码；仅写入本地忽略文件，未修改数据库。",
  );
} finally {
  await client.end();
}
