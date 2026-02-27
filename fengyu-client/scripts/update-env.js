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
