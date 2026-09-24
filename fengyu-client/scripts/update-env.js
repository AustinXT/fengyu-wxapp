/**
 * 使用腾讯云 SDK 更新云函数环境变量
 */

const tencentcloud = require("tencentcloud-sdk-nodejs");

const ScfClient = tencentcloud.scf.v20180416.Client;

// 从环境变量读取凭证（需要提前配置）
const clientConfig = {
  credential: {
    secretId: process.env.TENCENTCLOUD_SECRETID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY,
  },
  region: "ap-shanghai", // 根据实际情况修改
  profile: {
    httpProfile: {
      endpoint: "scf.tencentcloudapi.com",
    },
  },
};

const client = new ScfClient(clientConfig);

async function updateFunctionEnv() {
  try {
    // 1. 先获取当前函数配置
    const getParams = {
      FunctionName: "clientApi",
      Namespace: "cloud1-3gpht4b01ff88838", // 环境ID作为命名空间
    };

    console.log("获取当前函数配置...");
    const currentConfig = await client.GetFunction(getParams);

    // 2. 合并环境变量
    const existingEnv = currentConfig.Environment || {};
    const existingVars = existingEnv.Variables || [];

    // 从环境变量读取数据库连接串（由 configure-env.sh 从 .env 加载）
    const pgConnStr = process.env.PG_CONNECTION_STRING;
    const mssqlConnStr = process.env.MSSQL_CONNECTION_STRING;

    if (!pgConnStr || !mssqlConnStr) {
      console.error("错误: 未找到数据库连接串");
      console.error("  缺少: " + (!pgConnStr ? "PG_CONNECTION_STRING " : "") + (!mssqlConnStr ? "MSSQL_CONNECTION_STRING" : ""));
      console.error("请确认 fengyu-client/.env 文件存在且包含上述变量");
      process.exit(1);
    }

    // ⚠️ 目标断言：本脚本的来源是 gitignore 的 fengyu-client/.env，很容易残留已弃用的旧地址
    // （ali-demo 47.113.202.7 于 2026-09-01 停用，但仍可连通、数据陈旧）。没有断言就会把旧库
    // 连接串直接推进 dev 云函数。只放行当前两套业务库，其余一律拒绝。
    // 权威拓扑见 db/CLAUDE.md；正式部署请走 scripts/deploy-cloudfunctions.sh（以 envs/ 为唯一权威源）。
    // ⚠️ 本脚本的 Namespace 写死为 dev CloudBase（cloud1-3gpht4b01ff88838），
    // 所以只能放行 dev 库——放行 prod 串会把 dev 的 clientApi 直接改连生产库。
    const ALLOWED_PG = {
      "101.34.242.103": "dev",
    };
    let pgUrl;
    try {
      pgUrl = new URL(pgConnStr);
    } catch {
      console.error("错误: PG_CONNECTION_STRING 无法解析为 URL，拒绝推送");
      process.exit(1);
    }
    // query 参数可覆盖 authority 里的 host/port/dbname（libpq 语义），只比 authority 会被绕过
    const OVERRIDING = ["host", "hostaddr", "port", "dbname", "database", "options", "service", "passfile"];
    const overriding = OVERRIDING.filter((k) => pgUrl.searchParams.has(k));
    if (overriding.length) {
      console.error(`错误: PG_CONNECTION_STRING 的 query 试图覆盖连接目标（${overriding.join(", ")}），拒绝推送。`);
      process.exit(1);
    }
    if (!ALLOWED_PG[pgUrl.hostname] || pgUrl.port !== "5433" || pgUrl.pathname !== "/fengyu_wxapp") {
      console.error(`错误: PG_CONNECTION_STRING 指向 ${pgUrl.hostname}:${pgUrl.port}${pgUrl.pathname}，不在白名单内，拒绝推送。`);
      console.error("  允许: 仅 101.34.242.103:5433/fengyu_wxapp (dev) —— 本脚本只更新 dev CloudBase");
      console.error("  请先更新 fengyu-client/.env；若是旧的 47.113.202.7，该机已于 2026-09-01 全面弃用（见 issue #151）。");
      process.exit(1);
    }
    console.log(`✓ PG 目标校验通过：${pgUrl.hostname}（${ALLOWED_PG[pgUrl.hostname]}）`);

    // 新的环境变量
    const newVars = [
      { Key: "PG_CONNECTION_STRING", Value: pgConnStr },
      { Key: "MSSQL_CONNECTION_STRING", Value: mssqlConnStr },
    ];

    // 合并：保留旧的，添加/更新新的
    const mergedVars = [...existingVars];
    newVars.forEach((newVar) => {
      const index = mergedVars.findIndex((v) => v.Key === newVar.Key);
      if (index >= 0) {
        mergedVars[index] = newVar; // 更新
      } else {
        mergedVars.push(newVar); // 新增
      }
    });

    // 3. 更新函数配置
    const updateParams = {
      FunctionName: "clientApi",
      Namespace: "cloud1-3gpht4b01ff88838",
      Environment: {
        Variables: mergedVars,
      },
    };

    console.log("更新环境变量...");
    console.log("环境变量列表:", JSON.stringify(mergedVars, null, 2));

    const result = await client.UpdateFunctionConfiguration(updateParams);

    console.log("✓ 环境变量更新成功！");
    console.log("RequestId:", result.RequestId);

    return result;
  } catch (err) {
    console.error("✗ 更新失败:", err.message);
    if (err.code) {
      console.error("错误代码:", err.code);
    }
    throw err;
  }
}

// 执行
updateFunctionEnv()
  .then(() => {
    console.log("\n配置完成！");
    console.log("控制台链接: https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n配置失败:", err);
    process.exit(1);
  });
