// 只迁日报的新表，不允许重放旧分支迁移或写入生产。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, devConnection } from "./daily-dev-config.mjs";
const require = createRequire(path.join(ROOT, "db/package.json"));
const { Client } = require("pg");
const { migrate } = require("drizzle-orm/node-postgres/migrator");
const { drizzle } = require("drizzle-orm/node-postgres");
const { createHash } = require("node:crypto");
const client = new Client({
  connectionString: devConnection(),
  connectionTimeoutMillis: 5000,
});
try {
  await client.connect();
  const journal = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "db/migrations/meta/_journal.json"),
      "utf8",
    ),
  );
  const {
    rows: [latest],
  } = await client.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  if (!latest) throw new Error("开发库没有迁移基线，停止操作");
  const pending = journal.entries.filter(
    (e) => e.when > Number(latest.created_at),
  );
  if (pending.some((e) => e.tag !== "0061_daily_report_loop"))
    throw new Error("存在非日报待执行迁移，停止操作");
  const entry = journal.entries.find((e) => e.tag === "0061_daily_report_loop");
  const sql = fs.readFileSync(
    path.join(ROOT, "db/migrations/" + entry.tag + ".sql"),
    "utf8",
  );
  const hash = createHash("sha256").update(sql).digest("hex");
  if (!pending.length) {
    const { rows } = await client.query(
      "SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash=$1",
      [hash],
    );
    if (!rows.length)
      throw new Error("开发库迁移时序超过日报，但未记录日报迁移，停止操作");
  }
  console.log(
    `日报开发库迁移：101.34.242.103:5433/fengyu_wxapp，待执行 ${pending.length} 条`,
  );
  if (process.argv.includes("--apply")) {
    await migrate(drizzle(client), {
      migrationsFolder: path.join(ROOT, "db/migrations"),
    });
    const {
      rows: [tables],
    } = await client.query(
      "SELECT to_regclass('daily_reports') AS reports,to_regclass('daily_report_entries') AS entries,to_regclass('daily_wechat_bindings') AS bindings",
    );
    if (!Object.values(tables).every(Boolean))
      throw new Error("日报表回读不完整");
    console.log("日报三张表和迁移记录已核验");
  } else {
    console.log("仅检查；加 --apply 执行迁移");
  }
} catch (e) {
  console.error(e.code ? `数据库操作失败 (${e.code})` : e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
