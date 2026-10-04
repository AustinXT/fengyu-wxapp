import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DAILY_ENV = "cloud1-d5gz7zr8x6c38bd49";
export function devConnection() {
  const content = fs.readFileSync(path.join(ROOT, "envs/daily.env"), "utf8");
  const match = content.match(/^PG_CONNECTION_STRING=(.*)$/m);
  if (!match) throw new Error("envs/daily.env 缺少 PG_CONNECTION_STRING");
  const raw = match[1].trim().replace(/^["']|["']$/g, "");
  return validateDailyConnection(raw);
}
export function validateDailyConnection(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("日报数据库连接格式错误"); }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username || !url.password ||
    url.hostname !== "101.34.242.103" ||
    url.port !== "8151" ||
    url.pathname !== "/fengyu_daily_dev" ||
    url.search
  ) {
    throw new Error(
      "日报开发库必须为 101.34.242.103:8151/fengyu_daily_dev，且不能包含连接覆盖参数",
    );
  }
  return raw;
}
export function config() {
  const rc = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "fengyu-daily/cloudbaserc.example.json"),
      "utf8",
    ),
  );
  if (
    rc.envId !== DAILY_ENV ||
    rc.functions.length !== 1 ||
    rc.functions[0].name !== "dailyApiDev"
  )
    throw new Error("日报环境或函数名与固定目标不符");
  rc.functions[0].envVariables.PG_CONNECTION_STRING = devConnection();
  return rc;
}
