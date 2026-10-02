// 仅由 deploy-cloudfunctions.sh 的 daily 分支调用；独立账号不自动套用员工端密钥。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, DAILY_ENV, config } from "./daily-dev-config.mjs";
const [channel, plan] = process.argv.slice(2);
if (channel !== "dev")
  throw new Error(
    "日报首期仅支持 dev 通道，请显式使用 dev daily；正式发布需另行配置",
  );
if (fs.readFileSync(path.join(ROOT, "envs/.active"), "utf8").trim() !== "prod")
  throw new Error("envs/.active 必须为 prod");
const rc = config(),
  cwd = path.join(ROOT, "fengyu-daily");
console.log(
  `日报部署计划：dailyApiDev → ${DAILY_ENV} → dev PostgreSQL 101.34.242.103:5433/fengyu_wxapp`,
);
if (plan === "1") {
  console.log("仅预览，无配置写入和部署");
  process.exit(0);
}
fs.writeFileSync(
  path.join(cwd, "cloudbaserc.json"),
  JSON.stringify(rc, null, 2) + "\n",
  { mode: 0o600 },
);
function tcb(args) {
  const command = process.env.TCB_CLI_JS ? process.execPath : "tcb";
  const argv = process.env.TCB_CLI_JS
    ? [process.env.TCB_CLI_JS, ...args]
    : args;
  const r = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  // CLI 错误可能包含环境变量，禁止原样输出。
  if (r.error || r.status !== 0)
    throw new Error(
      `CloudBase CLI 操作失败：${args.slice(0, 3).join(" ")}。请检查账号权限、CLI 安装和网络。`,
    );
  return r.stdout;
}
function parseJSON(output) {
  const start = output.search(/^\{/m);
  if (start < 0) throw new Error("CLI 未返回可核验的 JSON 配置");
  return JSON.parse(output.slice(start, output.lastIndexOf("}") + 1));
}
if (process.env.DAILY_DEPLOY_BACKEND === "wechat") {
  const { deployWechat } = await import("./deploy-daily-wechat.mjs");
  await deployWechat(rc);
  process.exit(0);
}
if (!tcb(["env", "list"]).includes(DAILY_ENV))
  throw new Error(
    "当前账号看不到日报环境，请用 npx --yes --package=@cloudbase/cli tcb login 登录开通日报环境的账号后重试",
  );
const name = "dailyApiDev";
let exists = false;
// 明确区分“函数不存在”和鉴权/网络错误，不能把读取失败当首次创建。
const list = parseJSON(tcb(["fn", "list", "--json", "-e", DAILY_ENV]));
const functions =
  list.functions ||
  (Array.isArray(list.data) ? list.data : list.data?.functions) ||
  list.Functions || list.data?.Functions;
if (!Array.isArray(functions))
  throw new Error("无法识别函数列表，停止部署；请核对 CLI 版本");
exists = functions.some((f) => (f.name || f.FunctionName) === name);
if (exists) {
  const previous = parseJSON(
    tcb(["config", "pull", "fn", name, "--stdout", "--json", "-e", DAILY_ENV]),
  );
  const old = previous.functions?.find((f) => f.name === name);
  if (!old?.envVariables) throw new Error("无法读取现有环境变量，停止部署");
  rc.functions[0].envVariables = {
    ...old.envVariables,
    ...rc.functions[0].envVariables,
  };
  fs.writeFileSync(
    path.join(cwd, "cloudbaserc.json"),
    JSON.stringify(rc, null, 2) + "\n",
    { mode: 0o600 },
  );
  tcb(["fn", "code", "update", name, "--dir", "cloudfunctions/dailyApi"]);
} else {
  tcb(["fn", "deploy", name]);
}
const final = parseJSON(
  tcb(["config", "pull", "fn", name, "--stdout", "--json", "-e", DAILY_ENV]),
);
const actual = final.functions?.find((f) => f.name === name)?.envVariables;
for (const [key, value] of Object.entries(rc.functions[0].envVariables)) {
  if (actual?.[key] !== value) throw new Error(`部署后变量 ${key} 回读不一致`);
}
console.log("dailyApiDev 已部署，环境变量回读核验通过。");
