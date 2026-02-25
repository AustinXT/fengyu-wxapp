/**
 * 测试云函数环境变量是否生效
 */

const payload = {
  action: "store.list",
  payload: {}
};

console.log("测试参数:");
console.log(JSON.stringify(payload, null, 2));
console.log("\n请在 CloudBase 控制台的云函数测试面板中运行此测试");
console.log("控制台链接: https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf");
console.log("\n预期结果:");
console.log("- 如果环境变量配置正确，应该返回门店列表数据");
console.log("- 如果 PG_CONNECTION_STRING 未配置，会报错: '未配置 PG_CONNECTION_STRING'");
console.log("- 如果数据库连接失败，会报错: 'Connection refused' 或 '登录失败'");
